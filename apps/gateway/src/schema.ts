import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const payments = sqliteTable("payments", {
  id: text("id").primaryKey(),
  merchantReference: text("merchant_reference").notNull(),
  /** 金額，新台幣整數元。 */
  amountTwd: integer("amount_twd").notNull(),
  returnUrl: text("return_url").notNull(),
  webhookUrl: text("webhook_url").notNull(),
  /** 已存檔的狀態；pending 逾時後的 expired 由讀取時依 expires_at 推得，不落地。 */
  status: text("status", {
    enum: ["pending", "succeeded", "failed", "expired", "refunded", "refund_failed"],
  })
    .notNull()
    .default("pending"),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
  /** 建立付款時的測試旗標：下一次退款失敗（失敗一次即消耗，重試可成功）。 */
  failNextRefund: integer("fail_next_refund", { mode: "boolean" }).notNull().default(false),
});

export const events = sqliteTable("events", {
  id: text("id").primaryKey(),
  paymentId: text("payment_id")
    .notNull()
    .references(() => payments.id),
  type: text("type", { enum: ["payment.succeeded", "payment.failed", "payment.refunded"] }).notNull(),
  /** 事件本文（JSON 字串）在建立時固定，重送逐字相同。 */
  body: text("body").notNull(),
  createdAt: integer("created_at").notNull(),
});

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
