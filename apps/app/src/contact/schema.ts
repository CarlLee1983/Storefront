import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { user } from "../auth/schema";

/**
 * 聯絡 email 的驗證請求（聯絡資料，不是登入識別資料）。一列是一次「請驗證這個地址」：
 * 驗證成功（`verifiedAt`）才算顧客的通知收件地址，目前的收件地址是最近一次驗證成功的那一列；
 * 還沒驗證的新地址不取代既有已驗證地址，被新請求取代（`supersededAt`）或過期的請求不能再驗證。
 */
export const contactVerifications = sqliteTable(
  "contact_verifications",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    customerId: text("customer_id")
      .notNull()
      .references(() => user.id),
    /** 要驗證的地址（已正規化為小寫）。 */
    email: text("email").notNull(),
    /** 驗證連結的憑證；只出現在該顧客自己的模擬信箱，管理端不回傳。 */
    token: text("token").notNull(),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    verifiedAt: integer("verified_at"),
    supersededAt: integer("superseded_at"),
  },
  (table) => [
    uniqueIndex("contact_verifications_token_uidx").on(table.token),
    index("contact_verifications_customer_idx").on(table.customerId, table.verifiedAt),
  ],
);

/**
 * 模擬信箱裡的一封信（內容不可變）。信屬於一位顧客；實際寄到哪個地址記在每次投遞（`mailDeliveries`），
 * 之後換了聯絡 email 也不改寫既有信件與投遞紀錄。`kind` 由程式端限定（`MAIL_KINDS`），新增通知種類不需要改表。
 */
export const mailMessages = sqliteTable(
  "mail_messages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    customerId: text("customer_id")
      .notNull()
      .references(() => user.id),
    kind: text("kind").notNull(),
    subject: text("subject").notNull(),
    body: text("body").notNull(),
    /** 驗證信指向它要驗證的請求；顧客讀信時才依這個請求目前的狀態附上驗證連結。其他種類的信為 null。 */
    verificationId: integer("verification_id").references(() => contactVerifications.id),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("mail_messages_customer_idx").on(table.customerId, table.id)],
);

/** 投遞結果：送達才會出現在顧客的信箱；失敗留在管理端，可重送。 */
export const MAIL_DELIVERY_STATUSES = ["delivered", "failed"] as const;
export type MailDeliveryStatus = (typeof MAIL_DELIVERY_STATUSES)[number];

/**
 * 一次投遞嘗試。重送是同一封信的新一列，不是新的顧客事件；`recipientAddress` 是這次實際寄到的地址。
 */
export const mailDeliveries = sqliteTable(
  "mail_deliveries",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    messageId: integer("message_id")
      .notNull()
      .references(() => mailMessages.id),
    recipientAddress: text("recipient_address").notNull(),
    status: text("status").$type<MailDeliveryStatus>().notNull(),
    attemptedAt: integer("attempted_at").notNull(),
  },
  (table) => [
    index("mail_deliveries_message_idx").on(table.messageId),
    check("mail_deliveries_status_check", sql`${table.status} IN ('delivered', 'failed')`),
  ],
);

/**
 * 模擬信箱的演練控制，單列表（`id` 恆為 1，沒有這一列等於一切正常）。
 * `failDeliveries` 為 1 時，之後的每次投遞都失敗，用來演練投遞失敗與重送。
 */
export const mailControls = sqliteTable(
  "mail_controls",
  {
    id: integer("id").primaryKey(),
    failDeliveries: integer("fail_deliveries").notNull().default(0),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [check("mail_controls_check", sql`${table.id} = 1 AND ${table.failDeliveries} IN (0, 1)`)],
);
