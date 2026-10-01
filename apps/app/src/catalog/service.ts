import { drizzle } from "drizzle-orm/d1";
import { categorySlugInput } from "../categories/input";
import { selectListedCategories, selectListedCategoryBySlug } from "../categories/queries";
import { parseInput } from "../shared/input";
import { fail, ok } from "../shared/result";
import { listProductsInput } from "./input";
import { existsProductOnSale, selectListedProduct, selectListedProducts } from "./queries";

/** 前台讀取，不需登入。 */
export function createCatalogService(d1: D1Database) {
  const db = drizzle(d1);

  return {
    async getProduct(input: unknown) {
      if (typeof input !== "object" || input === null || !("id" in input) ||
        typeof input.id !== "number" || !Number.isSafeInteger(input.id) || input.id <= 0) return fail("not_found");
      const product = await selectListedProduct(db, input.id);
      return product ? ok(product) : fail("not_found");
    },
    /** 上架商品列表：依條件篩選與排序，回傳第 1 到 `page` 頁的累計結果；沒有輸入時是預設值。輸入不合法回 invalid_input。 */
    async listProducts(input: unknown) {
      const parsed = parseInput(listProductsInput, input === undefined ? {} : input);
      if (!parsed.ok) return parsed;
      const { items, total } = await selectListedProducts(db, parsed.data);
      return ok({ items, total, hasMore: items.length < total });
    },
    /** 導覽列需要的資料，一次取得：有上架商品的分類，以及目前有沒有特價商品（上架中且有原價）。 */
    async getStorefrontNav() {
      const [categories, hasSale] = await Promise.all([selectListedCategories(db), existsProductOnSale(db)]);
      return ok({ categories, hasSale });
    },
    /** 至少有一件上架商品的分類，依建立順序。 */
    async listCategories() {
      return ok(await selectListedCategories(db));
    },
    /** 依代稱取分類（商品由 listProducts 取得）；不合法的代稱、不存在、沒有上架商品都回 not_found。 */
    async getCategory(input: unknown) {
      const parsed = categorySlugInput.safeParse(input);
      if (!parsed.success) return fail("not_found");
      const category = await selectListedCategoryBySlug(db, parsed.data.slug);
      return category ? ok(category) : fail("not_found");
    },
  };
}
