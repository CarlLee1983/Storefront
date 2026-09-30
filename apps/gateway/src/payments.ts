import { and, eq, gt, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { PAYMENT_TTL_MS } from "./config";
import { payments } from "./schema";

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
  failNextRefund: boolean;
}

export async function insertPayment(db: Db, input: NewPayment, nowMs: number): Promise<PaymentRow> {
  const row: PaymentRow = {
    id: `pay_${crypto.randomUUID().replaceAll("-", "")}`,
    ...input,
    status: "pending",
    createdAt: nowMs,
    expiresAt: nowMs + PAYMENT_TTL_MS,
  };
  await db.insert(payments).values(row);
  return row;
}

export async function findPayment(db: Db, id: string): Promise<PaymentRow | undefined> {
  return (await db.select().from(payments).where(eq(payments.id, id)).limit(1))[0];
}

const REFUNDABLE: PaymentStatus[] = ["succeeded", "refund_failed"];

/**
 * 退款一次：succeeded 或 refund_failed（重試）才可退。帶著 failNextRefund 旗標時這一次失敗並消耗旗標。
 * 條件都寫在 UPDATE 裡，重複請求只會有一個成功轉換。
 */
export async function attemptRefund(db: Db, id: string): Promise<"refunded" | "refund_failed" | "not_refundable"> {
  const refundable = and(eq(payments.id, id), inArray(payments.status, REFUNDABLE));
  const failed = await db
    .update(payments)
    .set({ status: "refund_failed", failNextRefund: false })
    .where(and(refundable, eq(payments.failNextRefund, true)))
    .returning({ id: payments.id });
  if (failed.length > 0) return "refund_failed";

  const refunded = await db.update(payments).set({ status: "refunded" }).where(refundable).returning({ id: payments.id });
  return refunded.length > 0 ? "refunded" : "not_refundable";
}

/**
 * 只有「仍在有效期內的 pending」能轉成終態；條件寫在 UPDATE 裡，避免和取消／逾時競爭時後寫的蓋掉先寫的。
 * 回傳是否真的轉換了。
 */
export async function settlePending(
  db: Db,
  id: string,
  to: "succeeded" | "failed" | "expired",
  nowMs: number,
): Promise<boolean> {
  const updated = await db
    .update(payments)
    .set({ status: to })
    .where(and(eq(payments.id, id), eq(payments.status, "pending"), gt(payments.expiresAt, nowMs)))
    .returning({ id: payments.id });
  return updated.length > 0;
}
