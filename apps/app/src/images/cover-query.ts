import { sql, type SQL } from "drizzle-orm";
import type { ProductImage } from "../product-images";

/** Read the current first image, including for unlisted products; never snapshot it in an order. */
export function currentCover(productId: SQL): SQL<ProductImage | null> {
  return sql<ProductImage | null>`(
    select json_object('id', cover_image.id, 'variants', json(cover_image.variants))
    from product_images cover_image where cover_image.product_id = ${productId}
    order by cover_image.position, cover_image.id limit 1
  )`.mapWith((value: string | null) => value === null ? null : JSON.parse(value) as ProductImage);
}
