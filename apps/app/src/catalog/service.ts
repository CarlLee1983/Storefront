import { drizzle } from "drizzle-orm/d1";
import { categorySlugInput } from "../categories/input";
import { selectCategoryBySlug, selectListedCategories } from "../categories/queries";
import { fail, ok, type Result } from "../shared/result";
import { selectListedProduct, selectListedProducts, selectListedProductsInCategory, type ProductSummary } from "./queries";

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
    async listProducts(): Promise<Result<ProductSummary[], never>> {
      return ok(await selectListedProducts(db));
    },
    /** 至少有一件上架商品的分類，依建立順序。 */
    async listCategories() {
      return ok(await selectListedCategories(db));
    },
    /** 依代稱取分類與其上架商品（上架時間由新到舊）；不合法的代稱、不存在、沒有上架商品都回 not_found。 */
    async getCategory(input: unknown) {
      const parsed = categorySlugInput.safeParse(input);
      if (!parsed.success) return fail("not_found");
      const category = await selectCategoryBySlug(db, parsed.data.slug);
      if (!category) return fail("not_found");
      const products = await selectListedProductsInCategory(db, category.id);
      return products.length === 0 ? fail("not_found") : ok({ ...category, products });
    },
  };
}
