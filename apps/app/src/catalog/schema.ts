import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const products = sqliteTable("products", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  description: text("description").notNull(),
  /** 單價，新台幣整數元（含稅、免運）。 */
  priceTwd: integer("price_twd").notNull(),
  /** 是否上架；下架的商品從前台消失，但商品不能刪除。0 = 下架、1 = 上架。 */
  listed: integer("listed", { mode: "boolean" }).notNull().default(true),
  /** 在庫數（On Hand）；只能以增減量調整，不會小於 0。預設 0，讓舊版 App 的 INSERT 仍可執行。 */
  onHand: integer("on_hand").notNull().default(0),
});
