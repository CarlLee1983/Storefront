import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { orders } from "../orders/schema";
import { PAYMENT_STATUSES, type PaymentOutcome, type PaymentStatus } from "./shared";

export type { PaymentOutcome, PaymentStatus };

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
