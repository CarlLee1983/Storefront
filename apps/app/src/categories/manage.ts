import { cleanup, hashVariants, replay, writeVariants, type HashedVariant, type ProductImageBucket } from "../images/upload";
import type { SetCategoryImageInput } from "../images/input";
import type { ProductImage } from "../product-images";
import { fail, ok } from "../shared/result";

interface CurrentImage { imageId: string | null; uploadId: string | null; variants: string | null }

/** 分類與它目前的圖片（可能沒有）；分類不存在回 null。 */
async function findCurrent(d1: D1Database, id: number) {
  const row = await d1.prepare(`SELECT i.id AS imageId, i.upload_id AS uploadId, i.variants AS variants
    FROM categories c LEFT JOIN category_images i ON i.category_id = c.id WHERE c.id = ?`).bind(id).first<CurrentImage>();
  if (!row) return null;
  const image: ProductImage | null = row.imageId === null ? null : { id: row.imageId, variants: JSON.parse(row.variants!) as ProductImage["variants"] };
  return { uploadId: row.uploadId, image };
}

/**
 * 上傳或更換分類圖片（流程同商品圖片，ADR 0003）：先寫 R2 再用單句 upsert 寫 D1，
 * D1 失敗時盡力刪掉剛寫入的物件；D1 成功後盡力刪除舊圖的 R2 物件。
 * 相同 uploadId 重試回原圖片，不再寫 R2。
 */
export async function setCategoryImage(d1: D1Database, bucket: ProductImageBucket | undefined, input: SetCategoryImageInput) {
  const keys: string[] = [];
  let image: ProductImage | undefined;
  let variants: HashedVariant[] = [];
  let commitUncertain = false;
  try {
    const current = await findCurrent(d1, input.id);
    if (!current) return fail("category_not_found");
    variants = await hashVariants(input.variants);
    if (current.image && current.uploadId === input.uploadId) return replay(current.image, variants);
    if (!bucket) return fail("image_upload_failed");
    image = { id: crypto.randomUUID(), variants: [] };
    image.variants = await writeVariants(bucket, `categories/${input.id}/${image.id}`, variants, keys);
    // 單句 upsert：同一 uploadId 的並行重試至多換一次圖
    commitUncertain = true;
    const written = await d1.prepare(`
      INSERT INTO category_images (category_id, id, upload_id, variants)
      SELECT id, ?, ?, ? FROM categories WHERE id = ?
      ON CONFLICT (category_id) DO UPDATE SET id = excluded.id, upload_id = excluded.upload_id, variants = excluded.variants
        WHERE category_images.upload_id <> excluded.upload_id
      RETURNING id
    `).bind(image.id, input.uploadId, JSON.stringify(image.variants), input.id).first<{ id: string }>();
    commitUncertain = false;
    if (!written) {
      await cleanup(bucket, keys);
      const winner = await findCurrent(d1, input.id);
      return winner?.image && winner.uploadId === input.uploadId ? replay(winner.image, variants) : fail("category_not_found");
    }
    if (current.image) await cleanup(bucket, current.image.variants.map((variant) => variant.key));
    return ok({ image });
  } catch {
    if (commitUncertain) {
      // D1 可能已提交但回應遺失：先確認，不能把已提交圖片引用的物件刪掉。
      try {
        const saved = await findCurrent(d1, input.id);
        if (saved?.image && saved.uploadId === input.uploadId) {
          if (saved.image.id !== image?.id && bucket) await cleanup(bucket, keys);
          return replay(saved.image, variants);
        }
      } catch {
        // 無法確認是否提交時寧可留下可能的孤兒物件，也不能破壞成功的圖片。
        console.error(JSON.stringify({ event: "category_image_commit_unknown" }));
        return fail("image_upload_failed");
      }
    }
    if (bucket) await cleanup(bucket, keys);
    console.error(JSON.stringify({ event: "category_image_upload_failed" }));
    return fail("image_upload_failed");
  }
}

/**
 * 刪除沒有任何商品（不分上架與否）的分類，圖片記錄一併刪除。
 * 「沒有商品」的檢查與刪除在同一個 D1 批次，不會和同時發生的歸類互相穿插；R2 物件在 D1 成功後盡力刪除。
 */
export async function deleteCategory(d1: D1Database, bucket: ProductImageBucket | undefined, { id }: { id: number }) {
  const [images, categories] = await d1.batch([
    d1.prepare("DELETE FROM category_images WHERE category_id = ? AND NOT EXISTS (SELECT 1 FROM products WHERE category_id = ?) RETURNING variants").bind(id, id),
    d1.prepare("DELETE FROM categories WHERE id = ? AND NOT EXISTS (SELECT 1 FROM products WHERE category_id = ?) RETURNING id").bind(id, id),
  ]);
  if (categories!.results.length === 0) {
    const exists = await d1.prepare("SELECT 1 AS found FROM categories WHERE id = ?").bind(id).first();
    return fail(exists ? "category_not_empty" : "category_not_found");
  }
  if (bucket) {
    const keys = (images!.results as Array<{ variants: string }>).flatMap((row) => (JSON.parse(row.variants) as ProductImage["variants"]).map((variant) => variant.key));
    await cleanup(bucket, keys);
  }
  return ok({ id });
}
