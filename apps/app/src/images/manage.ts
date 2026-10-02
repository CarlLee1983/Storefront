import type { ProductImage } from "../product-images";
import { fail, ok } from "../shared/result";
import type { ProductImageBucket } from "./upload";

// Validate and update in one D1 transaction. Position is indexed, not UNIQUE:
// SQLite checks UNIQUE row-by-row and cannot atomically swap a full eight-image set.
// All writers preserve unique contiguous positions inside their atomic statements/batches.
export async function reorderProductImages(d1: D1Database, { id, imageIds }: { id: number; imageIds: string[] }) {
  const ids = JSON.stringify(imageIds);
  const matches = `(SELECT count(*) FROM product_images WHERE product_id = ?) = json_array_length(?)
    AND NOT EXISTS (SELECT 1 FROM product_images WHERE product_id = ? AND id NOT IN (SELECT value FROM json_each(?)))`;
  const results = await d1.batch([
    d1.prepare(`UPDATE product_images SET position = (SELECT CAST(key AS INTEGER) FROM json_each(?) WHERE value = product_images.id)
      WHERE product_id = ? AND ${matches}`).bind(ids, id, id, ids, id, ids),
    d1.prepare(`SELECT id, (${matches}) AS matches FROM products WHERE id = ?`).bind(id, ids, id, ids, id),
  ]);
  const product = results[1]!.results[0] as { id: number; matches: number } | undefined;
  if (!product) return fail("product_not_found");
  return product.matches ? ok({ id }) : fail("image_set_changed");
}

type Deletion = { id: string; product_id: number; variants: string };
async function finishDeletion(d1: D1Database, bucket: ProductImageBucket, row: Deletion) {
  const variants = JSON.parse(row.variants) as ProductImage["variants"];
  await bucket.delete(variants.map(variant => variant.key));
  await d1.prepare("DELETE FROM product_image_deletions WHERE id = ?").bind(row.id).run();
}

/** Retryable durable cleanup; Cron also drains failures after a browser is closed. */
export async function cleanupDeletedProductImages(d1: D1Database, bucket: ProductImageBucket | undefined) {
  if (!bucket) return;
  const rows = await d1.prepare("SELECT id, product_id, variants FROM product_image_deletions ORDER BY attempted_at, id LIMIT 20").all<Deletion>();
  for (const row of rows.results) {
    try { await finishDeletion(d1, bucket, row); }
    catch {
      // Rotate persistent failures behind unattempted entries instead of starving the queue.
      await d1.prepare("UPDATE product_image_deletions SET attempted_at = ? WHERE id = ?").bind(Date.now(), row.id).run();
      console.error(JSON.stringify({ event: "product_image_delete_retry_failed", imageId: row.id }));
    }
  }
}

export async function deleteProductImage(d1: D1Database, bucket: ProductImageBucket | undefined, { id, imageId }: { id: number; imageId: string }) {
  if (!bucket) return fail("image_delete_failed");
  try {
    // Guard + outbox + reference deletion + compaction are atomic. Concurrent
    // relisting/deletions cannot remove the last listed image. Never delete R2 first.
    const results = await d1.batch([
      d1.prepare(`INSERT INTO product_image_deletions (id, product_id, variants)
        SELECT i.id, i.product_id, i.variants FROM product_images i JOIN products p ON p.id = i.product_id
        WHERE i.product_id = ? AND i.id = ? AND (p.listed = 0 OR (SELECT count(*) FROM product_images WHERE product_id = p.id) > 1)
        ON CONFLICT(id) DO NOTHING`).bind(id, imageId),
      // 變體的 image_id 沒有外鍵，由此句維持不留懸空引用；與下一句同一個 batch，只在這張圖確定要刪（已進 outbox）時清
      d1.prepare("UPDATE product_variants SET image_id = NULL WHERE image_id = ? AND product_id = ? AND image_id IN (SELECT id FROM product_image_deletions WHERE product_id = ?)").bind(imageId, id, id),
      d1.prepare("DELETE FROM product_images WHERE product_id = ? AND id = ? AND id IN (SELECT id FROM product_image_deletions WHERE product_id = ?)").bind(id, imageId, id),
      d1.prepare(`WITH ranked AS MATERIALIZED (SELECT id, row_number() OVER (ORDER BY position, id) - 1 AS position FROM product_images WHERE product_id = ?)
        UPDATE product_images SET position = (SELECT position FROM ranked WHERE ranked.id = product_images.id) WHERE product_id = ?`).bind(id, id),
      d1.prepare("SELECT id, product_id, variants FROM product_image_deletions WHERE product_id = ? AND id = ?").bind(id, imageId),
      d1.prepare("SELECT id, listed, (SELECT count(*) FROM product_images WHERE product_id = products.id AND id = ?) AS has_image FROM products WHERE id = ?").bind(imageId, id),
    ]);
    const row = results[4]!.results[0] as Deletion | undefined;
    if (!row) {
      const product = results[5]!.results[0] as { listed: number; has_image: number } | undefined;
      if (!product) return fail("product_not_found");
      if (product.listed && product.has_image) return fail("last_product_image");
      // A retry after successful deletion (or completed Cron cleanup) is harmless.
      return ok({ id, imageId });
    }
    await finishDeletion(d1, bucket, row);
    return ok({ id, imageId });
  } catch {
    console.error(JSON.stringify({ event: "product_image_delete_failed", imageId }));
    return fail("image_delete_failed");
  }
}
