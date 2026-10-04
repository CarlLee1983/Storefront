import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { cancellationRequests } from "../cancellations/schema";
import { orders } from "../orders/schema";
import { returnRequests } from "../returns/schema";
import { shipmentReturns } from "../shipment-returns/schema";
import { shipmentLosses } from "../shipments/schema";
import {
  PAYMENT_STATUSES,
  RECONCILE_ISSUE_REASONS,
  REFUND_ATTEMPT_ACTIONS,
  REFUND_ATTEMPT_OUTCOMES,
  REFUND_REASONS,
  REFUND_STATUSES,
  type PaymentOutcome,
  type PaymentStatus,
  type ReconcileIssueReason,
  type RefundAttemptAction,
  type RefundAttemptOutcome,
  type RefundReason,
  type RefundStatus,
} from "./shared";

export type { PaymentOutcome, PaymentStatus, ReconcileIssueReason, RefundAttemptAction, RefundAttemptOutcome, RefundReason, RefundStatus };

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

const sqlList = (values: readonly string[]) => sql.raw(values.map((value) => `'${value}'`).join(", "));

/**
 * 退款（Refund）：把一筆成功收款的部分或全部款項退回的獨立款項處理，每筆各自記金額與進度（ADR 0007）；重試沿用同一列。
 * 閘道的冪等鍵與查證用的退款 ID 存在 `gateway_refund_id`：新紀錄是 `rf_<UUID>`（登記時由應用程式產生、隨 INSERT 寫入，之後永不更改，不可為空字串），
 * 0024 搬來的舊退款是 `legacy_<閘道付款 ID>`（對得上閘道 0002 搬來的退款），所以同一筆重送不會多退，舊退款也能向閘道查證。新增退款的程式一律走 `refunds.ts` 的承諾 helper。
 * 退款綁定一筆付款（`payment_id`，且該付款屬於 `order_id`）：金額上限是那筆付款的實收，不跨收款。
 * `goods_twd`、`shipping_twd` 是金額的拆分（商品款、原運費），讓後續的部分取消與發票折讓可以核對；兩者相加等於 `amount_twd`。
 * 狀態與額度規則見 `REFUND_STATUSES`；除 succeeded 外都佔用額度。
 */
export const refunds = sqliteTable(
  "refunds",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    orderId: integer("order_id")
      .notNull()
      .references(() => orders.id),
    paymentId: integer("payment_id")
      .notNull()
      .references(() => payments.id),
    reason: text("reason").$type<RefundReason>().notNull(),
    /** 向閘道送出與查證用的退款 ID（冪等鍵），見表說明。 */
    gatewayRefundId: text("gateway_refund_id").notNull(),
    /** 退款金額，新台幣整數元，大於 0。 */
    amountTwd: integer("amount_twd").notNull(),
    goodsTwd: integer("goods_twd").notNull(),
    shippingTwd: integer("shipping_twd").notNull(),
    status: text("status").$type<RefundStatus>().notNull().default("pending"),
    /** 取消核准產生的退款所屬的取消申請（一案最多一筆，唯一索引保證核准重送不重複登記）；其他原因為 null。 */
    cancellationRequestId: integer("cancellation_request_id").references(() => cancellationRequests.id),
    /** 退貨檢查完成產生的退款所屬的退貨申請（一案最多一筆，唯一索引保證重送不重複登記）；其他原因為 null。 */
    returnRequestId: integer("return_request_id").references(() => returnRequests.id),
    /** 確認遺失產生的退款所屬的遺失案件（一案最多一筆，唯一索引保證重送不重複登記）；其他原因為 null。 */
    shipmentLossId: integer("shipment_loss_id").references(() => shipmentLosses.id),
    /** 物流退回檢查完成產生的退款所屬的物流退回案件（一案最多一筆，唯一索引保證重送不重複登記）；其他原因為 null。 */
    shipmentReturnId: integer("shipment_return_id").references(() => shipmentReturns.id),
    /** 登記時間，UTC epoch 毫秒（高水位時鐘的有效時間）。 */
    createdAt: integer("created_at").notNull(),
    /** 最近一次進入 processing 的時間；程序中斷而卡在 processing 的退款以它判斷租約是否過期。 */
    claimedAt: integer("claimed_at"),
    /** 款項確認退回的時間；尚未成功為 null。 */
    settledAt: integer("settled_at"),
  },
  (table) => [
    index("refunds_order_idx").on(table.orderId),
    index("refunds_payment_idx").on(table.paymentId),
    uniqueIndex("refunds_gateway_refund_uidx").on(table.gatewayRefundId),
    uniqueIndex("refunds_cancellation_uidx").on(table.cancellationRequestId),
    uniqueIndex("refunds_return_uidx").on(table.returnRequestId),
    uniqueIndex("refunds_loss_uidx").on(table.shipmentLossId),
    uniqueIndex("refunds_shipment_return_uidx").on(table.shipmentReturnId),
    // 付款層級的原因（遲到、已取消、重複）每個原因一筆付款最多一筆：事件重送與補寫都不會登記第二筆
    uniqueIndex("refunds_payment_reason_uidx")
      .on(table.paymentId, table.reason)
      .where(sql`${table.reason} IN ('late_success_unreclaimable', 'cancelled_order', 'duplicate_success')`),
    check("refunds_gateway_refund_check", sql`${table.gatewayRefundId} <> ''`),
    check("refunds_status_check", sql`${table.status} IN (${sqlList(REFUND_STATUSES)})`),
    check("refunds_reason_check", sql`${table.reason} IN (${sqlList(REFUND_REASONS)})`),
    check("refunds_amount_check", sql`${table.amountTwd} > 0 AND ${table.goodsTwd} >= 0 AND ${table.shippingTwd} >= 0 AND ${table.goodsTwd} + ${table.shippingTwd} = ${table.amountTwd}`),
  ],
);

/**
 * 退款嘗試紀錄（只增不改）：每次向閘道送出或查證留一列，含操作者（`system` 或管理員 email）、動作與結果，
 * 讓退款的各次業務事實與管理員的操作可追溯。
 */
export const refundAttempts = sqliteTable(
  "refund_attempts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    refundId: integer("refund_id")
      .notNull()
      .references(() => refunds.id),
    /** 嘗試的時間，UTC epoch 毫秒。 */
    at: integer("at").notNull(),
    /** 觸發者：`system`（付款事件觸發的首次退款）或管理員 email。 */
    actor: text("actor").notNull(),
    action: text("action").$type<RefundAttemptAction>().notNull(),
    outcome: text("outcome").$type<RefundAttemptOutcome>().notNull(),
    /** 失敗或不明時閘道／連線的錯誤碼（例如 `refund_failed`、`unreachable`）；其他為 null。 */
    code: text("code"),
  },
  (table) => [
    index("refund_attempts_refund_idx").on(table.refundId),
    check("refund_attempts_action_check", sql`${table.action} IN (${sqlList(REFUND_ATTEMPT_ACTIONS)})`),
    check("refund_attempts_outcome_check", sql`${table.outcome} IN (${sqlList(REFUND_ATTEMPT_OUTCOMES)})`),
  ],
);
