import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { PAYMENT_TTL_MS } from "./config";
import { events, payments } from "./schema";
import { transitionWithEvent } from "./transitions";
import type { EventRow } from "./webhooks";

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

const REFUNDABLE: PaymentStatus[] = ["succeeded", "refund_failed"];

export type RefundAttempt =
  | { result: "refunded"; event: EventRow }
  | { result: "already_refunded" }
  | { result: "refund_failed" }
  | { result: "not_refundable"; status: PaymentStatus };

/**
 * 退款一次：succeeded 或 refund_failed（重試）才可退；已 refunded 視為冪等成功（不再產生事件）。
 * 帶著 failNextRefund 旗標時這一次失敗並消耗旗標。條件都寫在 UPDATE 裡，重複請求只會有一個成功轉換。
 */
export async function attemptRefund(db: Db, payment: PaymentRow, nowMs: number): Promise<RefundAttempt> {
  const failed = await db
    .update(payments)
    .set({ status: "refund_failed", failNextRefund: false })
    .where(and(eq(payments.id, payment.id), inArray(payments.status, REFUNDABLE), eq(payments.failNextRefund, true)))
    .returning({ id: payments.id });
  if (failed.length > 0) return { result: "refund_failed" };

  const event = await transitionWithEvent(
    db,
    payment,
    { from: REFUNDABLE, to: "refunded", event: "payment.refunded" },
    nowMs,
  );
  if (event) return { result: "refunded", event };

  // 沒轉換成功：以最新狀態判斷是冪等重送還是真的不能退（可能剛被別的請求改過）
  const latest = await findPayment(db, payment.id);
  if (latest?.status === "refunded") return { result: "already_refunded" };
  return { result: "not_refundable", status: latest?.status ?? payment.status };
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

/** 付款最近一個事件的 ID（成功／失敗／退款的結果事件，與 webhook 的 eventId 相同）；沒有事件為 null。 */
export async function latestEventId(db: Db, paymentId: string): Promise<string | null> {
  const rows = await db
    .select({ id: events.id })
    .from(events)
    .where(eq(events.paymentId, paymentId))
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
