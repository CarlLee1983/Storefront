import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { categories } from "../categories/schema";

export const products = sqliteTable("products", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  description: text("description").notNull(),
  /** 單價，新台幣整數元（含稅、免運）。 */
  priceTwd: integer("price_twd").notNull(),
  /** 原價，新台幣整數元；只用來在前台顯示劃線價，不參與結帳。有值（且上架中）就是特價商品，必須高於售價；可為空。 */
  compareAtPriceTwd: integer("compare_at_price_twd"),
  /** 是否上架；下架的商品從前台消失，但商品不能刪除。0 = 下架、1 = 上架。 */
  listed: integer("listed", { mode: "boolean" }).notNull().default(false),
  /** 在庫數（On Hand）；只能以增減量調整，不會小於 0。預設 0，讓舊版 App 的 INSERT 仍可執行。 */
  onHand: integer("on_hand").notNull().default(0),
  /** 所屬分類，可為空；上架中的商品必須有分類。 */
  categoryId: integer("category_id").references(() => categories.id),
  /** 最近一次上架或重新上架的時間，UTC epoch 毫秒；從未上架為空。 */
  listedAt: integer("listed_at"),
  /** 標為精選的時間，UTC epoch 毫秒；不是精選為空。下架商品可以保有精選標記。 */
  featuredAt: integer("featured_at"),
}, (table) => [
  index("products_category_listed_idx").on(table.categoryId, table.listed),
  // 特價商品只佔少數：部分索引讓「有沒有特價商品」與只看特價的查詢不必掃全表
  index("products_compare_at_price_idx").on(table.compareAtPriceTwd).where(sql`compare_at_price_twd is not null`),
]);
