import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/** 商品在前台的分組，只有一層；前台順序依建立順序（id 遞增）。 */
export const categories = sqliteTable("categories", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  /** 網址代稱：建立後沒有任何修改途徑。 */
  slug: text("slug").notNull(),
  name: text("name").notNull(),
  /** 一行說明。 */
  description: text("description").notNull(),
}, (table) => [uniqueIndex("categories_slug_uidx").on(table.slug)]);
