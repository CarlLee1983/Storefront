import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { categories } from "../categories/schema";

export const products = sqliteTable("products", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  description: text("description").notNull(),
  /** 是否上架；下架的商品從前台消失，但商品不能刪除。0 = 下架、1 = 上架。 */
  listed: integer("listed", { mode: "boolean" }).notNull().default(false),
  /** 所屬分類，可為空；上架中的商品必須有分類。 */
  categoryId: integer("category_id").references(() => categories.id),
  /** 最近一次上架或重新上架的時間，UTC epoch 毫秒；從未上架為空。 */
  listedAt: integer("listed_at"),
  /** 標為精選的時間，UTC epoch 毫秒；不是精選為空。下架商品可以保有精選標記。 */
  featuredAt: integer("featured_at"),
}, (table) => [
  index("products_category_listed_idx").on(table.categoryId, table.listed),
]);

/**
 * 商品變體（ADR 0005）：可獨立購買、定價與計算庫存的販售單位；購物車、價格校驗、訂單明細與庫存都以它為準。
 * 沒有選項的商品有且只有一個預設變體（`isDefault`）；多變體與選項維度由後續票擴充，不需要改動這張表的既有欄位。
 */
export const productVariants = sqliteTable("product_variants", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  productId: integer("product_id").notNull().references(() => products.id),
  /** 是否為預設變體；每個商品至多一個（部分唯一索引），沒有選項的商品以它販售。 */
  isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
  /** 單價，新台幣整數元（含稅、免運）。 */
  priceTwd: integer("price_twd").notNull(),
  /** 原價，新台幣整數元；只用來在前台顯示劃線價，不參與結帳。有值（且上架中）就是特價，必須高於售價；可為空。 */
  compareAtPriceTwd: integer("compare_at_price_twd"),
  /** 在庫數（On Hand）；只能以增減量調整，不會小於 0。 */
  onHand: integer("on_hand").notNull().default(0),
}, (table) => [
  index("product_variants_product_idx").on(table.productId),
  uniqueIndex("product_variants_default_uidx").on(table.productId).where(sql`is_default = 1`),
  // 特價變體只佔少數：部分索引讓「有沒有特價商品」與只看特價的查詢不必掃全表
  index("product_variants_compare_at_price_idx").on(table.compareAtPriceTwd).where(sql`compare_at_price_twd is not null`),
]);
