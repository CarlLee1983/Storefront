import { z } from "zod";
import type { Clock } from "./clock";
import { failure, success } from "./http";
import {
  attemptRefund,
  effectiveStatus,
  expirePending,
  findPayment,
  insertPayment,
  latestEventId,
  makeDb,
} from "./payments";
import { deliverEvent } from "./webhooks";

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
    // 最近一個事件（成功／失敗／退款）的 ID，與 webhook 的 eventId 相同，讓導回查詢與 webhook 共用冪等鍵；還沒有事件為 null
    eventId: await latestEventId(db, row.id),
  });
}

/** 退款：只有 succeeded 可退（refund_failed 可重試）；成功時立即送 payment.refunded。 */
export async function refundPayment(
  paymentId: string,
  env: Env,
  webhookSecret: string,
  clock: Clock,
): Promise<Response> {
  const db = makeDb(env);
  const row = await findPayment(db, paymentId);
  if (!row) return paymentNotFound();

  const attempt = await attemptRefund(db, row, clock.now());
  switch (attempt.result) {
    case "not_refundable":
      return failure(409, "payment_not_refundable", `付款是 ${attempt.status}，無法退款`);
    case "refund_failed":
      return failure(502, "refund_failed", "模擬的退款失敗，可以重試");
    case "already_refunded":
      return success({ paymentId: row.id, status: "refunded" });
    case "refunded":
      // 刻意同步投遞（決定論，見 deliverEvent），不要改成 waitUntil
      await deliverEvent(db, webhookSecret, clock, attempt.event, row.webhookUrl);
      return success({ paymentId: row.id, status: "refunded" });
  }
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
