import { drizzle } from "drizzle-orm/d1";
import { ok, type Result } from "../shared/result";
import { selectListedProducts, type ProductSummary } from "./queries";

/** 前台讀取，不需登入。 */
export function createCatalogService(d1: D1Database) {
  const db = drizzle(d1);

  return {
    async listProducts(): Promise<Result<ProductSummary[], never>> {
      return ok(await selectListedProducts(db));
    },
  };
}
