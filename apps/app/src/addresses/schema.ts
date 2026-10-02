import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { user } from "../auth/schema";

/**
 * 地址簿（Address Book）：顧客保存、供結帳選用的收件資訊。這裡的內容可編輯、可刪除；
 * 訂單的收件資訊是結帳當下複製進訂單的快照（`orders.shipping_*`），不引用這張表，所以改動或刪除地址不影響既有訂單。
 */
export const customerAddresses = sqliteTable(
  "customer_addresses",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    customerId: text("customer_id")
      .notNull()
      .references(() => user.id),
    name: text("name").notNull(),
    phone: text("phone").notNull(),
    address: text("address").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [index("customer_addresses_customer_idx").on(table.customerId, table.id)],
);
