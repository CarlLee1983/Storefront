import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { PAYMENT_TTL_MS } from "./config";
import { events, payments, refunds } from "./schema";

export type Db = ReturnType<typeof makeDb>;
export const makeDb = (env: Env) => drizzle(env.DB);

export type PaymentRow = typeof payments.$inferSelect;
export type PaymentStatus = PaymentRow["status"];

/** 對外看到的狀態：pending 過了 expires_at 就是 expired（讀取時推得，不落地）。 */
export const effectiveStatus = (row: PaymentRow, nowMs: number): PaymentStatus =>
  row.status === "pending" && nowMs >= row.expiresAt ? "expired" : row.status;

export interface NewPayment {
  merchantReference: string;
  amountTwd: number;
  returnUrl: string;
  webhookUrl: string;
  /** 呼叫端要求的最晚失效時間（epoch 毫秒）；實際失效時間不會晚於它。 */
  expiresAt?: number;
}

export async function insertPayment(db: Db, input: NewPayment, nowMs: number): Promise<PaymentRow> {
  const { expiresAt: requestedExpiresAt, ...fields } = input;
  const row: PaymentRow = {
    id: `pay_${crypto.randomUUID().replaceAll("-", "")}`,
    ...fields,
    status: "pending",
    failNextRefund: false,
    createdAt: nowMs,
    expiresAt: Math.min(nowMs + PAYMENT_TTL_MS, requestedExpiresAt ?? Number.POSITIVE_INFINITY),
  };
  await db.insert(payments).values(row);
  return row;
}

export async function findPayment(db: Db, id: string): Promise<PaymentRow | undefined> {
  return (await db.select().from(payments).where(eq(payments.id, id)).limit(1))[0];
}

export type RefundRow = typeof refunds.$inferSelect;

export type RefundAttempt =
  | { result: "succeeded"; refund: RefundRow }
  | { result: "failed" }
  | { result: "not_refundable"; status: PaymentStatus }
  /** 同一個退款 ID 帶了不同的付款或金額：冪等鍵不能對應到兩筆不同的退款。 */
  | { result: "conflict" }
  | { result: "exceeds_payment"; refundableTwd: number };

export async function findRefund(db: Db, paymentId: string, refundId: string): Promise<RefundRow | undefined> {
  return (await db.select().from(refunds).where(and(eq(refunds.id, refundId), eq(refunds.paymentId, paymentId))).limit(1))[0];
}

/** 這筆付款已成功退回的累計金額。 */
export async function refundedTwd(db: Db, paymentId: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`COALESCE(SUM(${refunds.amountTwd}), 0)` })
    .from(refunds)
    .where(and(eq(refunds.paymentId, paymentId), eq(refunds.status, "succeeded")));
  return row?.total ?? 0;
}

/**
 * 部分退款一次，以 `refundId` 為冪等鍵：同一個 ID 已成功就原樣回成功（不重複退）；明確失敗過的可用同一個 ID 重試，沿用同一筆退款。
 * 只有 succeeded 的付款可退；累計成功退款加這一筆不得超過付款金額，條件寫在 INSERT 的 SELECT 裡，並行的退款只有先到的那句生效。
 * 付款帶著 failNextRefund 旗標時這一次失敗並消耗旗標（退款記為 failed，不動款項）。
 */
export async function attemptRefund(
  db: Db,
  payment: PaymentRow,
  input: { refundId: string; amountTwd: number },
  nowMs: number,
): Promise<RefundAttempt> {
  const { refundId, amountTwd } = input;
  const existing = await findRefund(db, payment.id, refundId);
  const sameKeyElsewhere = !existing && (await db.select({ id: refunds.id }).from(refunds).where(eq(refunds.id, refundId)).limit(1)).length > 0;
  if (sameKeyElsewhere || (existing && existing.amountTwd !== amountTwd)) return { result: "conflict" };
  if (existing?.status === "succeeded") return { result: "succeeded", refund: existing };
  if (payment.status !== "succeeded") return { result: "not_refundable", status: payment.status };

  const flagged = await db
    .update(payments)
    .set({ failNextRefund: false })
    .where(and(eq(payments.id, payment.id), eq(payments.failNextRefund, true)))
    .returning({ id: payments.id });
  if (flagged.length > 0) {
    await db.insert(refunds).values({ id: refundId, paymentId: payment.id, amountTwd, status: "failed", createdAt: nowMs }).onConflictDoNothing();
    return { result: "failed" };
  }

  await db.$client
    .prepare(
      `INSERT INTO refunds (id, payment_id, amount_twd, status, created_at)
       SELECT ?1, ?2, ?3, 'succeeded', ?4
       WHERE (SELECT COALESCE(SUM(amount_twd), 0) FROM refunds WHERE payment_id = ?2 AND status = 'succeeded') + ?3
         <= (SELECT amount_twd FROM payments WHERE id = ?2 AND status = 'succeeded')
       ON CONFLICT (id) DO UPDATE SET status = 'succeeded' WHERE refunds.status = 'failed' AND refunds.payment_id = excluded.payment_id AND refunds.amount_twd = excluded.amount_twd`,
    )
    .bind(refundId, payment.id, amountTwd, nowMs)
    .run();
  const latest = await findRefund(db, payment.id, refundId);
  if (latest?.status === "succeeded") return { result: "succeeded", refund: latest };
  return { result: "exceeds_payment", refundableTwd: payment.amountTwd - (await refundedTwd(db, payment.id)) };
}

/** 主控頁：切換「下一次退款失敗」旗標；付款不存在回 undefined。 */
export async function toggleFailNextRefund(db: Db, id: string): Promise<boolean | undefined> {
  const updated = await db
    .update(payments)
    .set({ failNextRefund: sql`NOT ${payments.failNextRefund}` })
    .where(eq(payments.id, id))
    .returning({ failNextRefund: payments.failNextRefund });
  return updated[0]?.failNextRefund;
}

/** 付款最近一個事件的 ID（成功／失敗的結果事件，與 webhook 的 eventId 相同）；沒有事件為 null。 */
export async function latestEventId(db: Db, paymentId: string): Promise<string | null> {
  const rows = await db
    .select({ id: events.id })
    .from(events)
    .where(and(eq(events.paymentId, paymentId), inArray(events.type, ["payment.succeeded", "payment.failed"])))
    .orderBy(sql`${events}.rowid desc`)
    .limit(1);
  return rows[0]?.id ?? null;
}

/**
 * 讓仍在有效期內的 pending 付款失效（取消）；條件寫在 UPDATE 裡，避免和付款頁送出競爭時後寫的蓋掉先寫的。
 * 不產生事件。回傳是否真的轉換了。
 */
export async function expirePending(db: Db, id: string, nowMs: number): Promise<boolean> {
  const updated = await db
    .update(payments)
    .set({ status: "expired" })
    .where(and(eq(payments.id, id), eq(payments.status, "pending"), gt(payments.expiresAt, nowMs)))
    .returning({ id: payments.id });
  return updated.length > 0;
}
