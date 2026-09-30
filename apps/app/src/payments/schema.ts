import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { orders } from "../orders/schema";
import { PAYMENT_STATUSES, type PaymentOutcome, type PaymentStatus, type RefundReason } from "./shared";

export type { PaymentOutcome, PaymentStatus, RefundReason };

/** 付款（Payment）：針對某張訂單向金流閘道發起的一次收款嘗試；一張訂單可以有多筆。 */
export const payments = sqliteTable(
  "payments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    orderId: integer("order_id")
      .notNull()
      .references(() => orders.id),
    /** 閘道付款 ID；webhook 與導回查詢都靠它找到這筆付款，所以唯一。 */
    gatewayPaymentId: text("gateway_payment_id").notNull(),
    /** 發起當下的訂單總金額，新台幣整數元。 */
    amountTwd: integer("amount_twd").notNull(),
    status: text("status").$type<PaymentStatus>().notNull().default("pending"),
    /** 建立時間，UTC epoch 毫秒（高水位時鐘的有效時間）。 */
    createdAt: integer("created_at").notNull(),
    /** 閘道回報的失效時間，UTC epoch 毫秒；本地仍是 pending 但已過這個時間的付款，對外顯示為已失效。 */
    expiresAt: integer("expires_at").notNull(),
    /** 退款的觸發原因；沒有觸發過退款為 null。退款的結果在 `status`（refunded / refund_failed）。 */
    refundReason: text("refund_reason").$type<RefundReason>(),
    /** 退款結果記下的時間（成功或失敗都記），UTC epoch 毫秒（高水位時鐘的有效時間）；沒有觸發過退款為 null。 */
    refundAt: integer("refund_at"),
  },
  (table) => [
    uniqueIndex("payments_gateway_payment_uidx").on(table.gatewayPaymentId),
    index("payments_order_idx").on(table.orderId),
    check("payments_status_check", sql`${table.status} IN (${sql.raw(PAYMENT_STATUSES.map((status) => `'${status}'`).join(", "))})`),
  ],
);

/**
 * 已處理的閘道事件：`eventId` 唯一，「套用付款結果」靠它冪等（webhook 與導回查詢共用同一個事件 ID）。
 * `claim` 是搶到這個事件的那次呼叫寫入的隨機標記，讓同一個 batch 內的後續語句只在「本次呼叫搶到事件」時生效。
 */
export const paymentEvents = sqliteTable("payment_events", {
  eventId: text("event_id").primaryKey(),
  gatewayPaymentId: text("gateway_payment_id").notNull(),
  outcome: text("outcome").$type<PaymentOutcome>().notNull(),
  claim: text("claim").notNull(),
  /** 套用時間，UTC epoch 毫秒。 */
  appliedAt: integer("applied_at").notNull(),
});
