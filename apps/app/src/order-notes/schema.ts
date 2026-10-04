import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { orders } from "../orders/schema";

/**
 * 客服備註：管理員對訂單留下的內部紀錄，只增不改不刪（由資料庫 trigger 保證，比照庫存流水），顧客端永遠讀不到。
 * 更正錯誤的做法是再加一則備註；每則都留下操作者與時間。
 */
export const orderNotes = sqliteTable("order_notes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  orderId: integer("order_id").notNull().references(() => orders.id),
  /** 操作人：管理員 email。 */
  actor: text("actor").notNull(),
  note: text("note").notNull(),
  /** 留言時間，高水位的有效時間（UTC epoch 毫秒）。 */
  createdAt: integer("created_at").notNull(),
}, (table) => [
  index("order_notes_order_idx").on(table.orderId, table.id),
]);
