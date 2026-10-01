import { MAX_PRODUCT_IMAGES, type ProductImage } from "../product-images";
import { fail, invalidInput, ok } from "../shared/result";
import type { AddProductImageInput } from "./input";

export type ProductImageBucket = Pick<R2Bucket, "put" | "delete">;

/** 只刪除此嘗試專屬的 UUID namespace，不能誤刪同 uploadId 或同內容的成功上傳。 */
export async function cleanup(bucket: ProductImageBucket, keys: string[]) {
  try {
    if (keys.length) await bucket.delete(keys);
  } catch {
    console.error(JSON.stringify({ event: "product_image_cleanup_failed" }));
  }
}

async function findUpload(d1: D1Database, input: AddProductImageInput): Promise<ProductImage | null> {
  const row = await d1.prepare("SELECT id, variants FROM product_images WHERE product_id = ? AND upload_id = ?")
    .bind(input.id, input.uploadId).first<{ id: string; variants: string }>();
  return row ? { id: row.id, variants: JSON.parse(row.variants) as ProductImage["variants"] } : null;
}

export interface HashedVariant { width: number; height: number; bytes: Uint8Array<ArrayBuffer>; hash: string }
/** 依寬度由小到大排序，並算出每個尺寸內容的 SHA-256（image key 的一部分）。 */
export function hashVariants(input: Array<{ width: number; height: number; bytes: Uint8Array }>): Promise<HashedVariant[]> {
  return Promise.all([...input].sort((a, b) => a.width - b.width).map(async (variant) => {
    const bytes = new Uint8Array(variant.bytes);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const hash = [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
    return { width: variant.width, height: variant.height, bytes, hash };
  }));
}

/** 已存的圖片與這次上傳的內容是否一致；一致回原圖片（冪等重試），否則同一上傳識別碼被拿來傳不同圖片。 */
export function replay(image: ProductImage, variants: HashedVariant[]) {
  const matches = image.variants.length === variants.length && variants.every((variant, index) => {
    const saved = image.variants[index]!;
    return saved.width === variant.width && saved.height === variant.height && saved.key.endsWith(`/${variant.hash}.webp`);
  });
  return matches ? ok({ image }) : invalidInput({ uploadId: ["同一上傳識別碼不能用於不同的圖片"] });
}

/**
 * 依序寫進 R2，key 是 `<prefix>/<內容雜湊>.webp`。每個 key 在寫入前就記進 `keys`，
 * 中途失敗時呼叫端仍能清掉已寫入（與可能已寫入）的物件。
 */
export async function writeVariants(bucket: ProductImageBucket, prefix: string, variants: HashedVariant[], keys: string[]): Promise<ProductImage["variants"]> {
  const saved: ProductImage["variants"] = [];
  for (const variant of variants) {
    const key = `${prefix}/${variant.hash}.webp`;
    keys.push(key);
    await bucket.put(key, variant.bytes, { httpMetadata: { contentType: "image/webp", cacheControl: "public, max-age=31536000, immutable" } });
    saved.push({ key, width: variant.width, height: variant.height });
  }
  return saved;
}

export async function uploadProductImage(d1: D1Database, bucket: ProductImageBucket | undefined, input: AddProductImageInput) {
  const keys: string[] = [];
  let image: ProductImage | undefined;
  let variants: HashedVariant[] = [];
  let commitUncertain = false;
  try {
    const product = await d1.prepare("SELECT (SELECT count(*) FROM product_images WHERE product_id = products.id) AS image_count FROM products WHERE id = ?")
      .bind(input.id).first<{ image_count: number }>();
    if (!product) return fail("product_not_found");
    variants = await hashVariants(input.variants);
    const saved = await findUpload(d1, input);
    if (saved) return replay(saved, variants);
    if (product.image_count >= MAX_PRODUCT_IMAGES) return fail("image_limit");
    if (!bucket) return fail("image_upload_failed");
    image = { id: crypto.randomUUID(), variants: [] };
    image.variants = await writeVariants(bucket, `products/${input.id}/${image.id}`, variants, keys);
    // 單句配置順序、檢查 8 張上限與 uploadId 唯一性；並行重試至多新增一張。
    commitUncertain = true;
    const inserted = await d1.prepare(`
      INSERT INTO product_images (id, product_id, upload_id, position, variants)
      SELECT ?, id, ?, (SELECT coalesce(max(position), -1) + 1 FROM product_images WHERE product_id = products.id), ?
      FROM products WHERE id = ? AND (SELECT count(*) FROM product_images WHERE product_id = products.id) < ?
      ON CONFLICT (product_id, upload_id) DO NOTHING
      RETURNING id
    `).bind(image.id, input.uploadId, JSON.stringify(image.variants), input.id, MAX_PRODUCT_IMAGES).first<{ id: string }>();
    commitUncertain = false;
    if (!inserted) {
      await cleanup(bucket, keys);
      const winner = await findUpload(d1, input);
      return winner ? replay(winner, variants) : fail("image_limit");
    }
    return ok({ image });
  } catch {
    if (commitUncertain) {
      // D1 可能已提交但回應遺失：先確認，不能把已提交圖片引用的物件刪掉。
      try {
        const saved = await findUpload(d1, input);
        if (saved) {
          if (saved.id !== image?.id && bucket) await cleanup(bucket, keys);
          return replay(saved, variants);
        }
      } catch {
        // 無法確認是否提交時寧可留下可能的孤兒物件，也不能破壞成功的圖片。
        console.error(JSON.stringify({ event: "product_image_commit_unknown" }));
        return fail("image_upload_failed");
      }
    }
    if (bucket) await cleanup(bucket, keys);
    console.error(JSON.stringify({ event: "product_image_upload_failed" }));
    return fail("image_upload_failed");
  }
}
