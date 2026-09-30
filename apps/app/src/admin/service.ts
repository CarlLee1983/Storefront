import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { z } from "zod";
import { selectProductForAdmin, selectProductsForAdmin } from "../catalog/queries";
import { products } from "../catalog/schema";
import type { Clock } from "../shared/clock";
import { parseInput } from "../shared/input";
import { fail, ok, type InvalidInput, type ProductNotFound, type Unauthorized } from "../shared/result";
import { createAccessVerifier, type AccessConfig, type AccessIdentity } from "./access";
import { createProductInput, productIdInput, updateProductInput } from "./input";

export function createAdminService(d1: D1Database, clock: Clock, access: AccessConfig) {
  const db = drizzle(d1);
  const verifier = createAccessVerifier(access, clock);

  /** 管理 RPC 共同的前置：先驗 Access JWT，再驗輸入，通過才執行。 */
  async function authorized<S extends z.ZodType, T>(
    jwt: unknown,
    schema: S,
    input: unknown,
    run: (actor: AccessIdentity, data: z.output<S>) => Promise<T>,
  ): Promise<T | InvalidInput | Unauthorized> {
    const auth = await verifier.verify(jwt);
    if (!auth.ok) return auth;
    const parsed = parseInput(schema, input);
    if (!parsed.ok) return parsed;
    return run(auth.data, parsed.data);
  }

  /** 依 id 更新商品；沒有任何一列被更新（商品不存在）回 product_not_found。 */
  async function updateById(
    id: number,
    values: Partial<typeof products.$inferInsert>,
  ): Promise<{ ok: true; data: { id: number } } | ProductNotFound> {
    const updated = await db.update(products).set(values).where(eq(products.id, id)).returning({ id: products.id });
    return updated.length === 0 ? fail("product_not_found") : ok({ id });
  }

  return {
    async listProductsForAdmin(jwt: unknown) {
      const auth = await verifier.verify(jwt);
      if (!auth.ok) return auth;
      return ok(await selectProductsForAdmin(db));
    },

    /** 單一商品（含下架），給編輯頁用。 */
    getProductForAdmin(jwt: unknown, input: unknown) {
      return authorized(jwt, productIdInput, input, async (_actor, { id }) => {
        const product = await selectProductForAdmin(db, id);
        return product ? ok(product) : fail("product_not_found");
      });
    },

    /** 新增商品，預設上架。 */
    createProduct(jwt: unknown, input: unknown) {
      return authorized(jwt, createProductInput, input, async (_actor, data) => {
        const [row] = await db.insert(products).values({ ...data, listed: true }).returning({ id: products.id });
        return ok({ id: row!.id });
      });
    },

    /** 修改名稱、說明與單價；不動上架狀態。 */
    updateProduct(jwt: unknown, input: unknown) {
      return authorized(jwt, updateProductInput, input, (_actor, { id, ...values }) => updateById(id, values));
    },

    /** 下架：商品從前台消失，但保留在後台。已下架時也回成功（冪等）。 */
    unlistProduct(jwt: unknown, input: unknown) {
      return authorized(jwt, productIdInput, input, (_actor, { id }) => updateById(id, { listed: false }));
    },

    /** 重新上架：已上架時也回成功（冪等）。 */
    relistProduct(jwt: unknown, input: unknown) {
      return authorized(jwt, productIdInput, input, (_actor, { id }) => updateById(id, { listed: true }));
    },
  };
}
