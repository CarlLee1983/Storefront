import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { ProductImage } from "../product-images";

/** 商品在前台的分組，只有一層；前台順序依建立順序（id 遞增）。 */
export const categories = sqliteTable("categories", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  /** 網址代稱：建立後沒有任何修改途徑。 */
  slug: text("slug").notNull(),
  name: text("name").notNull(),
  /** 一行說明。 */
  description: text("description").notNull(),
}, (table) => [uniqueIndex("categories_slug_uidx").on(table.slug)]);

/** 分類圖片：每個分類至多一張，上傳新圖會取代舊圖；儲存格式與商品圖片相同（ADR 0003）。 */
export const categoryImages = sqliteTable("category_images", {
  categoryId: integer("category_id").primaryKey().references(() => categories.id),
  id: text("id").notNull(),
  uploadId: text("upload_id").notNull(),
  variants: text("variants", { mode: "json" }).$type<ProductImage["variants"]>().notNull(),
});
