import { and, eq, sql, type SQL } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { fail, ok, type ProductNotFound, type VariantNotFound } from "../shared/result";
import { productVariants, products } from "./schema";

/** 兩個維度以內的選項值／名稱，補成固定兩欄（空字串 = 沒有該維度）。 */
const padded = (values: readonly string[]): [string, string] => [values[0] ?? "", values[1] ?? ""];

/** 商品目前的選項維度個數的 SQL 表達式；`productId` 是外層查詢裡商品編號的表達式。 */
const optionCountOf = (productId: SQL) =>
  sql`(select (option1_name <> '') + (option2_name <> '') from products dimension_owner where dimension_owner.id = ${productId})`;

/** 唯一索引（同商品的選項值組合不可重複）擋下時 D1 的錯誤，可能包在 drizzle 的錯誤裡。 */
function isUniqueViolation(error: unknown): boolean {
  for (let cause: unknown = error; cause instanceof Error; cause = cause.cause) {
    if (cause.message.includes("UNIQUE constraint failed")) return true;
  }
  return false;
}

type VariantFailure = ProductNotFound | VariantNotFound
  | { ok: false; reason: "option_count_mismatch" | "options_locked" | "duplicate_variant" | "invalid_compare_at_price" | "image_not_found" };

/**
 * 只改維度名稱（個數不變）。條件寫入帶著「目前維度個數 = 先前讀到的個數」：
 * 讀取之後若被別的請求增減了維度，這句不更新，回 `options_locked`，不會把名稱寫進個數已不同的商品。
 */
export async function renameOptions(
  db: DrizzleD1Database,
  id: number,
  optionNames: string[],
  expectedCount: number,
): Promise<{ ok: true; data: { id: number } } | VariantFailure> {
  const [option1Name, option2Name] = padded(optionNames);
  const [updated] = await db.update(products).set({ option1Name, option2Name })
    .where(and(eq(products.id, id), sql`(${products.option1Name} <> '') + (${products.option2Name} <> '') = ${expectedCount}`))
    .returning({ id: products.id });
  return updated ? ok({ id }) : fail("options_locked");
}

/**
 * 設定選項維度名稱。個數不變只改名稱；個數改變時商品只能有一個變體（預設變體），並同批重設它的選項值：
 * 「只有一個變體」同時寫在兩句的條件裡，與同時新增變體的請求互斥，不會留下選項值個數與維度不符的變體。
 */
export async function setProductOptions(
  db: DrizzleD1Database,
  { id, optionNames, defaultVariantValues = [] }: { id: number; optionNames: string[]; defaultVariantValues?: string[] },
): Promise<{ ok: true; data: { id: number } } | VariantFailure> {
  const [product] = await db.select({ option1Name: products.option1Name, option2Name: products.option2Name }).from(products).where(eq(products.id, id));
  if (!product) return fail("product_not_found");
  const [option1Name, option2Name] = padded(optionNames);
  const currentCount = Number(product.option1Name !== "") + Number(product.option2Name !== "");
  if (optionNames.length === currentCount) return renameOptions(db, id, optionNames, currentCount);
  if (defaultVariantValues.length !== optionNames.length) return fail("option_count_mismatch");
  const [option1Value, option2Value] = padded(defaultVariantValues);
  const onlyVariant = sql`(select count(*) from product_variants where product_id = ${id}) = 1`;
  const [updatedVariant, updatedProduct] = await db.batch([
    db.update(productVariants).set({ option1Value, option2Value })
      .where(and(eq(productVariants.productId, id), eq(productVariants.isDefault, true), onlyVariant)).returning({ id: productVariants.id }),
    db.update(products).set({ option1Name, option2Name }).where(and(eq(products.id, id), onlyVariant)).returning({ id: products.id }),
  ]);
  return updatedVariant.length && updatedProduct.length ? ok({ id }) : fail("options_locked");
}

/**
 * 新增變體（非預設）：選項值個數必須等於商品的維度個數（至少一個，沒有選項的商品只有預設變體）。
 * 維度個數的檢查與寫入同一句；組合重複由唯一索引擋下。新變體在庫數為 0，且販售中。
 */
export async function createVariant(
  db: DrizzleD1Database,
  { productId, optionValues, priceTwd, compareAtPriceTwd }: { productId: number; optionValues: string[]; priceTwd: number; compareAtPriceTwd?: number },
): Promise<{ ok: true; data: { id: number } } | VariantFailure> {
  if (compareAtPriceTwd !== undefined && compareAtPriceTwd <= priceTwd) return fail("invalid_compare_at_price");
  const [option1Value, option2Value] = padded(optionValues);
  const dimensionsMatch = optionValues.length > 0 ? sql`${optionCountOf(sql`products.id`)} = ${optionValues.length}` : sql`0`;
  try {
    const [created] = await db.all<{ id: number }>(sql`
      INSERT INTO product_variants (product_id, is_default, price_twd, compare_at_price_twd, on_hand, option1_value, option2_value)
      SELECT products.id, 0, ${priceTwd}, ${compareAtPriceTwd ?? null}, 0, ${option1Value}, ${option2Value}
      FROM products WHERE products.id = ${productId} AND ${dimensionsMatch}
      RETURNING id`);
    if (created) return ok({ id: created.id });
  } catch (error) {
    if (isUniqueViolation(error)) return fail("duplicate_variant");
    throw error;
  }
  const [product] = await db.select({ id: products.id }).from(products).where(eq(products.id, productId));
  return product ? fail("option_count_mismatch") : fail("product_not_found");
}

/**
 * 修改變體的選項值、售價，以及（有帶時）原價與指定圖片。維度個數、「原價仍高於售價」、「圖片屬於同一商品」
 * 都寫在 UPDATE 的條件裡；沒有任何一列被更新時，再逐項查出原因。
 */
export async function updateVariant(
  db: DrizzleD1Database,
  { variantId, optionValues, priceTwd, compareAtPriceTwd, imageId }:
    { variantId: number; optionValues: string[]; priceTwd: number; compareAtPriceTwd?: number | null; imageId?: string | null },
): Promise<{ ok: true; data: { id: number } } | VariantFailure> {
  if (typeof compareAtPriceTwd === "number" && compareAtPriceTwd <= priceTwd) return fail("invalid_compare_at_price");
  const [option1Value, option2Value] = padded(optionValues);
  const keepsCompareAt = compareAtPriceTwd === undefined;
  const ownImage = (id: string) => sql`exists (select 1 from product_images where id = ${id} and product_id = product_variants.product_id)`;
  try {
    const [updated] = await db.update(productVariants)
      .set({
        priceTwd,
        option1Value,
        option2Value,
        ...(keepsCompareAt ? {} : { compareAtPriceTwd }),
        ...(imageId === undefined ? {} : { imageId }),
      })
      .where(and(
        eq(productVariants.id, variantId),
        sql`${optionCountOf(sql`product_variants.product_id`)} = ${optionValues.length}`,
        keepsCompareAt ? sql`(${productVariants.compareAtPriceTwd} is null or ${productVariants.compareAtPriceTwd} > ${priceTwd})` : undefined,
        typeof imageId === "string" ? ownImage(imageId) : undefined,
      ))
      .returning({ id: productVariants.id });
    if (updated) return ok({ id: updated.id });
  } catch (error) {
    if (isUniqueViolation(error)) return fail("duplicate_variant");
    throw error;
  }
  const [variant] = await db
    .select({ compareAtPriceTwd: productVariants.compareAtPriceTwd, dimensions: optionCountOf(sql`product_variants.product_id`).mapWith(Number) })
    .from(productVariants).where(eq(productVariants.id, variantId));
  if (!variant) return fail("variant_not_found");
  if (variant.dimensions !== optionValues.length) return fail("option_count_mismatch");
  if (keepsCompareAt && variant.compareAtPriceTwd !== null && variant.compareAtPriceTwd <= priceTwd) return fail("invalid_compare_at_price");
  return fail("image_not_found");
}

/** 停賣或恢復販售；停賣時記下時間（已停賣再停賣不更新時間，冪等）。變體本身與歷史訂單都保留。 */
export async function setVariantDiscontinued(
  db: DrizzleD1Database,
  variantId: number,
  discontinued: boolean,
  now: number,
): Promise<{ ok: true; data: { id: number } } | VariantNotFound> {
  const [updated] = await db.update(productVariants)
    .set({ discontinuedAt: discontinued ? sql`coalesce(${productVariants.discontinuedAt}, ${now})` : null })
    .where(eq(productVariants.id, variantId)).returning({ id: productVariants.id });
  return updated ? ok({ id: updated.id }) : fail("variant_not_found");
}
