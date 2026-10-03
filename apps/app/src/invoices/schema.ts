import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { orders } from "../orders/schema";
import { payments, refunds } from "../payments/schema";
import {
  ALLOWANCE_STATUSES,
  INVOICE_ATTEMPT_ACTIONS,
  INVOICE_ATTEMPT_OUTCOMES,
  INVOICE_STATUSES,
  type AllowanceStatus,
  type InvoiceAttemptAction,
  type InvoiceAttemptOutcome,
  type InvoiceStatus,
} from "./shared";

export type { AllowanceStatus, InvoiceAttemptAction, InvoiceAttemptOutcome, InvoiceStatus };

const sqlList = (values: readonly string[]) => sql.raw(values.map((value) => `'${value}'`).join(", "));

/**
 * 模擬發票（Simulated Invoice）：一筆成功收款一張，原額等於那筆收款的實收，開立之後不改寫（折讓另外記，見 `allowanceObligations`）。
 * 付款轉為成功的同一個 batch 寫入一列 `pending`（開立義務，`payment_id` 唯一，事件重送不重複），之後才在交易外向發票服務開立；
 * 服務失敗或逾時都不影響付款，留待補辦。`gateway_invoice_key` 是向發票服務送出與查證用的冪等鍵：登記時由應用程式產生、之後永不更改，
 * 所以同一張發票的重送、補辦與查證永遠帶同一個鍵，不會重複開立。只演練一般個人消費發票，沒有統編、載具或捐贈。
 */
export const invoices = sqliteTable(
  "invoices",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    orderId: integer("order_id")
      .notNull()
      .references(() => orders.id),
    paymentId: integer("payment_id")
      .notNull()
      .references(() => payments.id),
    gatewayInvoiceKey: text("gateway_invoice_key").notNull(),
    /** 原額，新台幣整數元：登記當下那筆收款的實收，不因退款改變。 */
    amountTwd: integer("amount_twd").notNull(),
    status: text("status").$type<InvoiceStatus>().notNull().default("pending"),
    /** 發票服務給的發票號碼；尚未開立為 null。 */
    invoiceNumber: text("invoice_number"),
    /** 登記開立義務的時間，UTC epoch 毫秒（高水位時鐘的有效時間）。 */
    createdAt: integer("created_at").notNull(),
    /** 開立成功的時間；尚未開立為 null。 */
    issuedAt: integer("issued_at"),
  },
  (table) => [
    uniqueIndex("invoices_payment_uidx").on(table.paymentId),
    uniqueIndex("invoices_gateway_key_uidx").on(table.gatewayInvoiceKey),
    index("invoices_order_idx").on(table.orderId),
    check("invoices_status_check", sql`${table.status} IN (${sqlList(INVOICE_STATUSES)})`),
    check("invoices_gateway_key_check", sql`${table.gatewayInvoiceKey} <> ''`),
    check("invoices_amount_check", sql`${table.amountTwd} > 0`),
    check("invoices_issued_check", sql`(${table.status} = 'issued') = (${table.invoiceNumber} IS NOT NULL AND ${table.issuedAt} IS NOT NULL)`),
  ],
);

/** 開立嘗試紀錄（只增不改）：每次向發票服務送出或查證留一列，含操作者（`system` 或管理員 email）、動作與結果。 */
export const invoiceAttempts = sqliteTable(
  "invoice_attempts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    invoiceId: integer("invoice_id")
      .notNull()
      .references(() => invoices.id),
    /** 嘗試的時間，UTC epoch 毫秒。 */
    at: integer("at").notNull(),
    actor: text("actor").notNull(),
    action: text("action").$type<InvoiceAttemptAction>().notNull(),
    outcome: text("outcome").$type<InvoiceAttemptOutcome>().notNull(),
    /** 失敗或不明時發票服務／連線的錯誤碼（例如 `invoice_failed`、`unreachable`）；其他為 null。 */
    code: text("code"),
  },
  (table) => [
    index("invoice_attempts_invoice_idx").on(table.invoiceId),
    check("invoice_attempts_action_check", sql`${table.action} IN (${sqlList(INVOICE_ATTEMPT_ACTIONS)})`),
    check("invoice_attempts_outcome_check", sql`${table.outcome} IN (${sqlList(INVOICE_ATTEMPT_OUTCOMES)})`),
  ],
);

/**
 * 待折讓義務與折讓：一筆成功的退款一列（`refund_id` 唯一），與退款轉為成功同一個 batch 寫入（見 `payments/refunds.ts` 的 `recordRefundAttempt`），
 * 之後在交易外向發票服務逐筆折讓（`status` 由 `pending` 轉為 `issued`），折讓金額是退款原額，累計不超過原票金額（收款實收）。
 * 義務綁定收款而不是發票：退款可能先於延遲開立的發票成功，先保留退款事實；原票開立成功（含補辦）之前不送出折讓，不產生無原票的折讓。
 * `gateway_allowance_key` 是向發票服務送出與查證用的冪等鍵：登記時由應用程式產生、之後永不更改，所以重送、補辦與查證永遠帶同一個鍵，不會重複折讓。
 * 保留不隨訂單或發票狀態刪除，也不改寫金額（退款成功後金額不變）；已折讓的不會被蓋回。
 */
export const allowanceObligations = sqliteTable(
  "allowance_obligations",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    refundId: integer("refund_id")
      .notNull()
      .references(() => refunds.id),
    paymentId: integer("payment_id")
      .notNull()
      .references(() => payments.id),
    orderId: integer("order_id")
      .notNull()
      .references(() => orders.id),
    /** 退款金額（要折讓的金額），新台幣整數元。 */
    amountTwd: integer("amount_twd").notNull(),
    /** 退款確認成功的時間，UTC epoch 毫秒（高水位時鐘的有效時間）。 */
    createdAt: integer("created_at").notNull(),
    gatewayAllowanceKey: text("gateway_allowance_key").notNull(),
    status: text("status").$type<AllowanceStatus>().notNull().default("pending"),
    /** 發票服務給的折讓號碼；尚未折讓為 null。 */
    allowanceNumber: text("allowance_number"),
    /** 折讓成功的時間；尚未折讓為 null。 */
    issuedAt: integer("issued_at"),
  },
  (table) => [
    uniqueIndex("allowance_obligations_refund_uidx").on(table.refundId),
    uniqueIndex("allowance_obligations_gateway_key_uidx").on(table.gatewayAllowanceKey),
    index("allowance_obligations_payment_idx").on(table.paymentId),
    index("allowance_obligations_order_idx").on(table.orderId),
    check("allowance_obligations_amount_check", sql`${table.amountTwd} > 0`),
    check("allowance_obligations_status_check", sql`${table.status} IN (${sqlList(ALLOWANCE_STATUSES)})`),
    check("allowance_obligations_gateway_key_check", sql`${table.gatewayAllowanceKey} <> ''`),
    check("allowance_obligations_issued_check", sql`(${table.status} = 'issued') = (${table.allowanceNumber} IS NOT NULL AND ${table.issuedAt} IS NOT NULL)`),
  ],
);

/** 折讓嘗試紀錄（只增不改）：每次向發票服務送出或查證留一列，欄位同 `invoiceAttempts`。 */
export const allowanceAttempts = sqliteTable(
  "allowance_attempts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    allowanceId: integer("allowance_id")
      .notNull()
      .references(() => allowanceObligations.id),
    /** 嘗試的時間，UTC epoch 毫秒。 */
    at: integer("at").notNull(),
    actor: text("actor").notNull(),
    action: text("action").$type<InvoiceAttemptAction>().notNull(),
    outcome: text("outcome").$type<InvoiceAttemptOutcome>().notNull(),
    /** 失敗或不明時發票服務／連線的錯誤碼；其他為 null。 */
    code: text("code"),
  },
  (table) => [
    index("allowance_attempts_allowance_idx").on(table.allowanceId),
    check("allowance_attempts_action_check", sql`${table.action} IN (${sqlList(INVOICE_ATTEMPT_ACTIONS)})`),
    check("allowance_attempts_outcome_check", sql`${table.outcome} IN (${sqlList(INVOICE_ATTEMPT_OUTCOMES)})`),
  ],
);
