import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { z } from "zod";
import { selectProductForAdmin, selectProductsForAdmin } from "../catalog/queries";
import { products } from "../catalog/schema";
import { adjustOnHand } from "../catalog/stock";
import { selectOrderCustomerEmail, selectOrdersForAdmin } from "../orders/admin-queries";
import { orderIdInput } from "../orders/input";
import { markOrderShipped, orderExists, selectOrderById } from "../orders/queries";
import { SHIPPED } from "../orders/schema";
import { selectOrderPaymentSummaries } from "../payments/queries";
import type { Clock } from "../shared/clock";
import { parseInput } from "../shared/input";
import { fail, ok, type InvalidInput, type ProductNotFound, type Unauthorized } from "../shared/result";
import { createAccessVerifier, type AccessConfig, type AccessIdentity } from "./access";
import { adjustStockInput, createProductInput, listOrdersInput, productIdInput, shipOrderInput, updateProductInput } from "./input";

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

    /** 庫存調整：只接受增減量，不能覆寫成某個數字。 */
    adjustStock(jwt: unknown, input: unknown) {
      return authorized(jwt, adjustStockInput, input, (_actor, { id, delta }) => adjustOnHand(db, id, delta));
    },

    /** 所有訂單，可依訂單狀態篩選；新的在前。`input` 可省略（不篩選）。 */
    listOrdersForAdmin(jwt: unknown, input: unknown) {
      return authorized(jwt, listOrdersInput, input ?? {}, async (_actor, { status }) => ok(await selectOrdersForAdmin(db, status)));
    },

    /**
     * 出貨（Shipment）：把已付款的訂單標為已出貨，物流單號可以不附；已出貨是終點，不能撤回。
     * 不是已付款（待付款、已逾期、已取消、已出貨）回 `order_not_shippable`，不存在回 `order_not_found`。
     */
    shipOrder(jwt: unknown, input: unknown) {
      return authorized(jwt, shipOrderInput, input, async (actor, { orderId, trackingNumber }) => {
        if (await markOrderShipped(d1, orderId, trackingNumber, clock.now())) {
          console.log(JSON.stringify({ event: "order_shipped", orderId, actor: actor.email, hasTrackingNumber: trackingNumber !== null }));
          return ok({ orderId, status: SHIPPED });
        }
        return fail((await orderExists(db, orderId)) ? "order_not_shippable" : "order_not_found");
      });
    },

    /** 單張訂單的明細：訂單明細快照、收件資訊、所有付款嘗試、物流單號與出貨時間。 */
    getOrderForAdmin(jwt: unknown, input: unknown) {
      return authorized(jwt, orderIdInput, input, async (_actor, { orderId }) => {
        const order = await selectOrderById(db, orderId);
        const customerEmail = await selectOrderCustomerEmail(db, orderId);
        if (!order || customerEmail === undefined) return fail("order_not_found");
        const payments = await selectOrderPaymentSummaries(db, clock.now(), orderId);
        return ok({ ...order, customerEmail, payments });
      });
    },
  };
}
