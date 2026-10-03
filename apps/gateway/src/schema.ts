import { sql } from "drizzle-orm";
import { check, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const payments = sqliteTable("payments", {
  id: text("id").primaryKey(),
  merchantReference: text("merchant_reference").notNull(),
  /** 金額，新台幣整數元。 */
  amountTwd: integer("amount_twd").notNull(),
  returnUrl: text("return_url").notNull(),
  webhookUrl: text("webhook_url").notNull(),
  /** 已存檔的狀態；pending 逾時後的 expired 由讀取時依 expires_at 推得，不落地。 */
  status: text("status", {
    enum: ["pending", "succeeded", "failed", "expired"],
  })
    .notNull()
    .default("pending"),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
  /** 開發主控頁切換的測試旗標：下一次退款嘗試失敗（失敗一次即消耗，以同一退款 ID 重試可成功）。 */
  failNextRefund: integer("fail_next_refund", { mode: "boolean" }).notNull().default(false),
});

export const events = sqliteTable(
  "events",
  {
    id: text("id").primaryKey(),
    paymentId: text("payment_id")
      .notNull()
      .references(() => payments.id),
    type: text("type", { enum: ["payment.succeeded", "payment.failed"] }).notNull(),
    /** 事件本文（JSON 字串）在建立時固定，重送逐字相同。 */
    body: text("body").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  // 一筆付款每種終局事件最多一個：成功、失敗各只會發生一次，結構上不可能重複發事件
  (table) => [uniqueIndex("events_payment_type_unique").on(table.paymentId, table.type)],
);

export const deliveries = sqliteTable("deliveries", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  eventId: text("event_id")
    .notNull()
    .references(() => events.id),
  attemptedAt: integer("attempted_at").notNull(),
  /** 對方回的 HTTP 狀態；連線失敗或逾時為 null。 */
  statusCode: integer("status_code"),
  delivered: integer("delivered", { mode: "boolean" }).notNull(),
  error: text("error"),
});

/**
 * 退款（部分退款）：一筆成功的付款可以有多筆退款，各自以呼叫端給的退款 ID 為冪等鍵。
 * 狀態只有 succeeded（款項已退回）與 failed（明確失敗，可用同一 ID 重試）；累計 succeeded 的金額不得超過付款金額。
 */
export const refunds = sqliteTable("refunds", {
  /** 呼叫端的退款 ID（本站放本地退款紀錄的編號）；同一個 ID 重送就是同一筆退款。 */
  id: text("id").primaryKey(),
  paymentId: text("payment_id")
    .notNull()
    .references(() => payments.id),
  amountTwd: integer("amount_twd").notNull(),
  status: text("status", { enum: ["succeeded", "failed"] }).notNull(),
  createdAt: integer("created_at").notNull(),
});

/**
 * 模擬發票：以呼叫端給的 `invoice_key` 為冪等鍵，同一個鍵重送回同一張發票（同金額），不會重複開立。
 * 發票號碼由閘道隨機產生並唯一（`invoice_number` 唯一索引），開立之後不再改變；只演練一般個人消費發票，沒有統編、載具或捐贈。
 */
export const invoices = sqliteTable(
  "invoices",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    invoiceKey: text("invoice_key").notNull(),
    merchantReference: text("merchant_reference").notNull(),
    /** 原額，新台幣整數元。 */
    amountTwd: integer("amount_twd").notNull(),
    invoiceNumber: text("invoice_number").notNull(),
    issuedAt: integer("issued_at").notNull(),
  },
  (table) => [uniqueIndex("invoices_invoice_key_uidx").on(table.invoiceKey), uniqueIndex("invoices_invoice_number_uidx").on(table.invoiceNumber)],
);

/**
 * 模擬發票服務的演練控制，單列表（`id` 恆為 1，沒有這一列等於一切正常）：
 * `fail_next` 為 1 時下一次開立明確失敗（不開立、旗標用完即清）；`lose_next_response` 為 1 時下一次開立已成立、但回應遺失（回 504，呼叫端須查證）。
 */
export const invoiceControls = sqliteTable(
  "invoice_controls",
  {
    id: integer("id").primaryKey(),
    failNext: integer("fail_next").notNull().default(0),
    loseNextResponse: integer("lose_next_response").notNull().default(0),
  },
  (table) => [check("invoice_controls_check", sql`${table.id} = 1 AND ${table.failNext} IN (0, 1) AND ${table.loseNextResponse} IN (0, 1)`)],
);

/**
 * 模擬發票折讓：以呼叫端給的 `allowance_key` 為冪等鍵，同一個鍵重送回同一張折讓（同金額、同發票），不會重複折讓。
 * 折讓一定掛在已開立的發票上（`invoice_key`），同一張發票累計折讓不超過發票原額；折讓號碼由閘道隨機產生並唯一。
 */
export const allowances = sqliteTable(
  "allowances",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    allowanceKey: text("allowance_key").notNull(),
    invoiceKey: text("invoice_key").notNull(),
    /** 折讓金額，新台幣整數元。 */
    amountTwd: integer("amount_twd").notNull(),
    allowanceNumber: text("allowance_number").notNull(),
    issuedAt: integer("issued_at").notNull(),
  },
  (table) => [uniqueIndex("allowances_allowance_key_uidx").on(table.allowanceKey), uniqueIndex("allowances_allowance_number_uidx").on(table.allowanceNumber)],
);

/** 模擬折讓的演練控制，單列表（`id` 恆為 1）：語意同 `invoiceControls`，作用在下一次折讓。 */
export const allowanceControls = sqliteTable(
  "allowance_controls",
  {
    id: integer("id").primaryKey(),
    failNext: integer("fail_next").notNull().default(0),
    loseNextResponse: integer("lose_next_response").notNull().default(0),
  },
  (table) => [check("allowance_controls_check", sql`${table.id} = 1 AND ${table.failNext} IN (0, 1) AND ${table.loseNextResponse} IN (0, 1)`)],
);
