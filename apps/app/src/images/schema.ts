import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { products } from "../catalog/schema";
import type { ProductImage } from "../product-images";

export const productImages = sqliteTable("product_images", {
  id: text("id").primaryKey(),
  productId: integer("product_id").notNull().references(() => products.id),
  uploadId: text("upload_id").notNull(),
  position: integer("position").notNull(),
  variants: text("variants", { mode: "json" }).$type<ProductImage["variants"]>().notNull(),
}, (table) => [
  uniqueIndex("product_images_product_upload_uidx").on(table.productId, table.uploadId),
  index("product_images_product_position_idx").on(table.productId, table.position),
  check("product_images_position_check", sql`${table.position} >= 0 AND ${table.position} < 8`),
]);

/** Durable outbox: remove references atomically, then delete only this image's R2 objects. */
export const productImageDeletions = sqliteTable("product_image_deletions", {
  attemptedAt: integer("attempted_at").notNull().default(0),
  id: text("id").primaryKey(),
  productId: integer("product_id").notNull(),
  variants: text("variants", { mode: "json" }).$type<ProductImage["variants"]>().notNull(),
});
