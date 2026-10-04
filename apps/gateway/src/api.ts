import { z } from "zod";
import type { Clock } from "./clock";
import { failure, success } from "./http";
import {
  attemptRefund,
  effectiveStatus,
  expirePending,
  findPayment,
  findRefund,
  insertPayment,
  latestEventId,
  makeDb,
  refundedTwd,
} from "./payments";

const httpUrl = (label: string) =>
  z.url({ protocol: /^https?$/, error: `${label}必須是 http(s) 網址` });

const createPaymentSchema = z.object({
  merchantReference: z.string({ error: "merchantReference 必填" }).min(1, "merchantReference 必填"),
  amountTwd: z
    .number({ error: "amountTwd 必須是數字" })
    .int("amountTwd 必須是整數")
    .positive("amountTwd 必須大於 0"),
  returnUrl: httpUrl("returnUrl"),
  webhookUrl: httpUrl("webhookUrl"),
  // 呼叫端希望付款最晚失效的時間（epoch 毫秒）；實際失效時間取它與「建立時間 + 付款有效期」的較早者
  expiresAt: z.number({ error: "expiresAt 必須是數字（epoch 毫秒）" }).int("expiresAt 必須是整數").optional(),
});

function invalidInput(error: z.ZodError) {
  const fields: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const field = typeof issue.path[0] === "string" ? issue.path[0] : "_form";
    (fields[field] ??= []).push(issue.message);
  }
  return failure(400, "invalid_input", "輸入不合法", fields);
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

export async function createPayment(request: Request, env: Env, clock: Clock): Promise<Response> {
  const parsed = createPaymentSchema.safeParse(await readJson(request));
  if (!parsed.success) return invalidInput(parsed.error);

  const now = clock.now();
  if (parsed.data.expiresAt !== undefined && parsed.data.expiresAt <= now) {
    return failure(400, "invalid_input", "輸入不合法", { expiresAt: ["expiresAt 必須晚於現在"] });
  }

  const row = await insertPayment(makeDb(env), parsed.data, now);
  return success(
    { paymentId: row.id, paymentUrl: `${new URL(request.url).origin}/pay/${row.id}`, expiresAt: row.expiresAt },
    201,
  );
}

const paymentNotFound = () => failure(404, "payment_not_found", "找不到這筆付款");

export async function getPayment(paymentId: string, env: Env, clock: Clock): Promise<Response> {
  const db = makeDb(env);
  const row = await findPayment(db, paymentId);
  if (!row) return paymentNotFound();
  return success({
    paymentId: row.id,
    status: effectiveStatus(row, clock.now()),
    amountTwd: row.amountTwd,
    merchantReference: row.merchantReference,
    expiresAt: row.expiresAt,
    // 最近一個事件（成功／失敗）的 ID，與 webhook 的 eventId 相同，讓導回查詢與 webhook 共用冪等鍵；還沒有事件為 null
    eventId: await latestEventId(db, row.id),
    // 已成功退回的累計金額（部分退款）；付款本身的狀態不因退款改變
    refundedTwd: await refundedTwd(db, row.id),
  });
}

const refundSchema = z.object({
  refundId: z
    .string({ error: "refundId 必填" })
    .regex(/^[A-Za-z0-9_-]{1,100}$/, "refundId 只能是 1 至 100 個英數、底線或連字號"),
  amountTwd: z.number({ error: "amountTwd 必須是數字" }).int("amountTwd 必須是整數").positive("amountTwd 必須大於 0"),
});

const refundData = (paymentId: string, refund: { id: string; status: string; amountTwd: number }) => ({
  refundId: refund.id,
  paymentId,
  status: refund.status,
  amountTwd: refund.amountTwd,
});

/**
 * 部分退款：以 `refundId` 為冪等鍵，同一個 ID 重送回同一筆退款的結果（已成功不重複退，明確失敗的可重試）；
 * 只有 succeeded 的付款可退，累計退款不得超過付款金額。不送 webhook：呼叫端以 `GET .../refunds/:refundId` 查證結果。
 */
export async function refundPayment(paymentId: string, request: Request, env: Env, clock: Clock): Promise<Response> {
  const parsed = refundSchema.safeParse(await readJson(request));
  if (!parsed.success) return invalidInput(parsed.error);
  const db = makeDb(env);
  const row = await findPayment(db, paymentId);
  if (!row) return paymentNotFound();

  const attempt = await attemptRefund(db, row, parsed.data, clock.now());
  switch (attempt.result) {
    case "succeeded":
      return success(refundData(row.id, attempt.refund));
    case "failed":
      return failure(502, "refund_failed", "模擬的退款失敗，可以用同一個 refundId 重試");
    case "conflict":
      return failure(409, "refund_conflict", "這個 refundId 已對應另一筆不同的退款");
    case "not_refundable":
      return failure(409, "payment_not_refundable", `付款是 ${attempt.status}，無法退款`);
    case "exceeds_payment":
      return failure(409, "refund_exceeds_payment", `累計退款不得超過付款金額，目前最多還能退 ${attempt.refundableTwd}`);
  }
}

/** 查證一筆退款（結果不明時先查再決定）；從未收到這個 refundId 回 404 `refund_not_found`。 */
export async function getRefund(paymentId: string, refundId: string, env: Env): Promise<Response> {
  const db = makeDb(env);
  if (!(await findPayment(db, paymentId))) return paymentNotFound();
  const refund = await findRefund(db, paymentId, refundId);
  if (!refund) return failure(404, "refund_not_found", "找不到這筆退款");
  return success(refundData(paymentId, refund));
}

/** 讓進行中的付款失效（顧客取消訂單時）；已是 expired 視為成功，已有結果的付款不能取消。 */
export async function cancelPayment(paymentId: string, env: Env, clock: Clock): Promise<Response> {
  const db = makeDb(env);
  const row = await findPayment(db, paymentId);
  if (!row) return paymentNotFound();

  const status = effectiveStatus(row, clock.now());
  if (status === "pending") {
    if (await expirePending(db, row.id, clock.now())) return success({ paymentId: row.id, status: "expired" });
    // 讀取與更新之間狀態變了（付款頁剛好送出），以最新狀態為準
    return failure(409, "payment_not_cancellable", "付款剛剛已有結果，無法取消");
  }
  if (status === "expired") return success({ paymentId: row.id, status: "expired" });
  return failure(409, "payment_not_cancellable", `付款已是 ${status}，無法取消`);
}
