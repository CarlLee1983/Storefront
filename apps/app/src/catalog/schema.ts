import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { categories } from "../categories/schema";
import type { DeliveryType } from "../shipping/types";

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
  /** 選項維度（Option）名稱，例如「顏色」；最多兩個，空字串表示沒有該維度（沒有選項的商品兩者皆空）。第二個有值時第一個一定有值，由管理 RPC 維持。 */
  option1Name: text("option1_name").notNull().default(""),
  option2Name: text("option2_name").notNull().default(""),
  /** 尺寸、材質與保養資訊：純文字，由管理員維護，空字串表示未提供（詳情頁不顯示該項）。 */
  dimensions: text("dimensions").notNull().default(""),
  material: text("material").notNull().default(""),
  care: text("care").notNull().default(""),
}, (table) => [
  index("products_category_listed_idx").on(table.categoryId, table.listed),
]);

/**
 * 商品變體（ADR 0005）：可獨立購買、定價與計算庫存的販售單位；購物車、價格校驗、訂單明細與庫存都以它為準。
 * 沒有選項的商品有且只有一個預設變體（`isDefault`）；「恰一個」目前只由 `createProduct` 的 batch 保證（部分唯一索引只擋「超過一個」）。
 * 後續若要切換預設變體，須在同一 batch 先清舊的再設新的。
 * 選項值（`option1Value`、`option2Value`）的個數必須等於商品的選項維度個數（由管理 RPC 在寫入的同一句檢查）；
 * 同商品的選項值組合不可重複。停賣（`discontinuedAt`）的變體不再接受新購買，仍保留供後台與歷史訂單使用。
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
  /**
   * 不可售數量（Unavailable，ADR 0006）：在庫數中待檢或損壞而不可販售的退貨，另列、不是另一份庫存。
   * 可售 = 在庫 − 不可售 − 保留；不會小於 0、也不會大於在庫數（寫入端條件保證，見 `returns/`、`stock/scrap.ts`）。
   */
  unavailable: integer("unavailable").notNull().default(0),
  /** 對應商品選項維度的選項值，例如「胡桃色」；空字串表示沒有該維度（讓唯一索引能比對「同一組合」）。 */
  option1Value: text("option1_value").notNull().default(""),
  option2Value: text("option2_value").notNull().default(""),
  /** 停賣時間，UTC epoch 毫秒；null 表示販售中。 */
  discontinuedAt: integer("discontinued_at"),
  /**
   * 選取此變體時顯示的商品圖片（`product_images.id`）；null 表示不指定。
   * 沒有外鍵（外鍵會讓回復遷移必須重建資料表）：「圖片屬於同一商品」由 `updateVariant` 在寫入的同一句檢查，
   * 圖片刪除時由 `deleteProductImage` 在同一個 batch 清空。
   */
  imageId: text("image_id"),
  /**
   * 配送類型（`shipping/types.ts`）：下單時按它計運費，並快照到訂單明細。由管理 RPC 的輸入驗證限定為已知類型
   *（新增欄位不另設 CHECK，否則遷移要重建資料表）。
   */
  deliveryType: text("delivery_type").$type<DeliveryType>().notNull().default("standard"),
  /**
   * 低庫存門檻：未停賣（含下架商品）的變體可售數量（`catalog/stock.ts`）降到這個數量以下（含）就列入低庫存提醒；null 表示不提醒（初始值）。
   * 提醒是從可售數量與這個門檻即時推導的，沒有另存「已提醒」狀態，庫存一變動提醒就同步更新。
   */
  lowStockThreshold: integer("low_stock_threshold"),
}, (table) => [
  uniqueIndex("product_variants_options_uidx").on(table.productId, table.option1Value, table.option2Value),
  index("product_variants_product_idx").on(table.productId),
  uniqueIndex("product_variants_default_uidx").on(table.productId).where(sql`is_default = 1`),
  // 特價變體只佔少數：部分索引讓「有沒有特價商品」與只看特價的查詢不必掃全表
  // 有設門檻的變體只佔少數：低庫存清單只掃這些
  index("product_variants_low_stock_idx").on(table.lowStockThreshold).where(sql`low_stock_threshold is not null`),
  index("product_variants_compare_at_price_idx").on(table.compareAtPriceTwd).where(sql`compare_at_price_twd is not null`),
]);
