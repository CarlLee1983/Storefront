import { drizzle } from "drizzle-orm/d1";
import { fail, ok, type Result } from "../shared/result";
import { selectListedProduct, selectListedProducts, type ProductSummary } from "./queries";

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
  };
}
