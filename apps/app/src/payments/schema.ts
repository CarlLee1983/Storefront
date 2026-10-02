import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { orders } from "../orders/schema";
import { PAYMENT_STATUSES, RECONCILE_ISSUE_REASONS, type PaymentOutcome, type PaymentStatus, type ReconcileIssueReason, type RefundReason } from "./shared";

export type { PaymentOutcome, PaymentStatus, ReconcileIssueReason, RefundReason };

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
    /** 最近一次補查（向閘道查證）的時間，不論結果，UTC epoch 毫秒；從沒補查過為 null。Cron 依它輪替，查不出結果的付款不會擋住其他付款。 */
    reconciledAt: integer("reconciled_at"),
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

/**
 * 付款補查的待辦：補查（Cron 或管理員觸發）向閘道查證一筆仍是 pending 的付款卻沒能確認結果時，每筆付款一列（upsert）。
 * 待辦是否還開著只看 `resolved_at` 是否為 null：付款一離開 pending（webhook、導回查詢、補查套用結果，或轉為已失效）就同步記為已解決。
 * 保留已解決的列，讓之前出過什麼問題、試過幾次仍可追溯。
 */
export const paymentReconcileIssues = sqliteTable(
  "payment_reconcile_issues",
  {
    paymentId: integer("payment_id")
      .primaryKey()
      .references(() => payments.id),
    reason: text("reason").$type<ReconcileIssueReason>().notNull(),
    /** 這一輪待辦（從出現到解決）失敗的補查次數。 */
    attempts: integer("attempts").notNull(),
    /** 這一輪待辦第一次出現的時間，UTC epoch 毫秒。 */
    firstAt: integer("first_at").notNull(),
    /** 最近一次補查失敗的時間，UTC epoch 毫秒。 */
    lastAt: integer("last_at").notNull(),
    /** 最近一次補查的觸發者：`cron` 或管理員 email。 */
    lastSource: text("last_source").notNull(),
    /** 待辦解決的時間（付款有了結果，或補查確認閘道說仍在等待）；仍開著為 null。 */
    resolvedAt: integer("resolved_at"),
  },
  (table) => [
    check(
      "payment_reconcile_issues_reason_check",
      sql`${table.reason} IN (${sql.raw(RECONCILE_ISSUE_REASONS.map((reason) => `'${reason}'`).join(", "))})`,
    ),
  ],
);
