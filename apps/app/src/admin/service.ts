import { and, eq, isNotNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { z } from "zod";
import { selectProductForAdmin, selectProductsForAdmin } from "../catalog/queries";
import { products } from "../catalog/schema";
import { adjustOnHand } from "../catalog/stock";
import { categoryIdInput, createCategoryInput, updateCategoryInput } from "../categories/input";
import { deleteCategory, setCategoryImage } from "../categories/manage";
import { isValidSlug } from "../categories/slug";
import { categoryExists, insertCategory, selectCategoriesForAdmin, selectCategoryForAdmin, updateCategoryById } from "../categories/queries";
import { addProductImageInput, reorderProductImagesInput, deleteProductImageInput, setCategoryImageInput } from "../images/input";
import { reorderProductImages, deleteProductImage } from "../images/manage";
import { uploadProductImage, type ProductImageBucket } from "../images/upload";
import { selectOrdersForAdmin } from "../orders/admin-queries";
import { orderIdInput } from "../orders/input";
import { markOrderShipped, orderExists, selectOrderForAdmin } from "../orders/queries";
import { SHIPPED } from "../orders/schema";
import { selectOrderPaymentSummaries } from "../payments/queries";
import type { Clock } from "../shared/clock";
import { parseInput } from "../shared/input";
import { fail, ok, type InvalidInput, type ProductNotFound, type Unauthorized } from "../shared/result";
import { createAccessVerifier, type AccessConfig, type AccessIdentity } from "./access";
import { adjustStockInput, createProductInput, listOrdersInput, productIdInput, shipOrderInput, updateProductInput } from "./input";

export function createAdminService(d1: D1Database, clock: Clock, access: AccessConfig, images?: ProductImageBucket) {
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

    /** 新增商品，預設下架。 */
    createProduct(jwt: unknown, input: unknown) {
      return authorized(jwt, createProductInput, input, async (_actor, data) => {
        const [row] = await db.insert(products).values({ ...data, listed: false }).returning({ id: products.id });
        return ok({ id: row!.id });
      });
    },

    /** 商品圖片：先驗 JWT 與輸入，再寫 R2 與 D1。 */
    addProductImage(jwt: unknown, input: unknown) {
      return authorized(jwt, addProductImageInput, input, (_actor, data) => uploadProductImage(d1, images, data));
    },

    reorderProductImages(jwt: unknown, input: unknown) {
      return authorized(jwt, reorderProductImagesInput, input, (_actor, data) => reorderProductImages(d1, data));
    },

    deleteProductImage(jwt: unknown, input: unknown) {
      return authorized(jwt, deleteProductImageInput, input, (_actor, data) => deleteProductImage(d1, images, data));
    },

    /**
     * 修改名稱、說明、單價與分類；不動上架狀態。
     * 指定的分類不存在回 `category_not_found`；上架中的商品不能把分類清成空，回 `no_category`（下架中的可以）。
     */
    updateProduct(jwt: unknown, input: unknown) {
      return authorized(jwt, updateProductInput, input, async (_actor, { id, ...values }) => {
        if (typeof values.categoryId === "number" && !(await categoryExists(db, values.categoryId))) return fail("category_not_found");
        const clearsCategory = values.categoryId === null;
        // 「上架中不能清空分類」寫進同一句 UPDATE 的條件，不會和同時發生的上架互相穿插
        const updated = await db.update(products).set(values)
          .where(and(eq(products.id, id), clearsCategory ? eq(products.listed, false) : undefined))
          .returning({ id: products.id });
        if (updated.length) return ok({ id });
        const [product] = await db.select({ id: products.id }).from(products).where(eq(products.id, id));
        return product ? fail("no_category") : fail("product_not_found");
      });
    },

    /** 建立分類：代稱格式錯回 `invalid_slug`、已被使用回 `slug_taken`。代稱建立後沒有任何修改途徑。 */
    createCategory(jwt: unknown, input: unknown) {
      return authorized(jwt, createCategoryInput, input, async (_actor, data) => {
        if (!isValidSlug(data.slug)) return fail("invalid_slug");
        const created = await insertCategory(db, data);
        return created ? ok(created) : fail("slug_taken");
      });
    },

    /** 修改分類的名稱與說明（代稱沒有修改途徑，帶了也忽略）；不存在回 `category_not_found`。 */
    updateCategory(jwt: unknown, input: unknown) {
      return authorized(jwt, updateCategoryInput, input, async (_actor, { id, ...values }) =>
        (await updateCategoryById(db, id, values)) ? ok({ id }) : fail("category_not_found"));
    },

    /** 上傳或更換分類圖片（每個分類至多一張）：先驗 JWT 與輸入，再寫 R2 與 D1。 */
    setCategoryImage(jwt: unknown, input: unknown) {
      return authorized(jwt, setCategoryImageInput, input, (_actor, data) => setCategoryImage(d1, images, data));
    },

    /** 刪除沒有任何商品（不分上架與否）的分類，圖片一併刪除；有商品回 `category_not_empty`。 */
    deleteCategory(jwt: unknown, input: unknown) {
      return authorized(jwt, categoryIdInput, input, (_actor, data) => deleteCategory(d1, images, data));
    },

    /** 單一分類（含圖片與商品數）；不存在回 `category_not_found`。 */
    getCategoryForAdmin(jwt: unknown, input: unknown) {
      return authorized(jwt, categoryIdInput, input, async (_actor, { id }) => {
        const category = await selectCategoryForAdmin(db, id);
        return category ? ok(category) : fail("category_not_found");
      });
    },

    /** 所有分類（含沒有上架商品的），依建立順序，帶圖片、商品數與上架商品數。 */
    async listCategoriesForAdmin(jwt: unknown) {
      const auth = await verifier.verify(jwt);
      if (!auth.ok) return auth;
      return ok(await selectCategoriesForAdmin(db));
    },

    /** 下架：商品從前台消失，但保留在後台。已下架時也回成功（冪等）。 */
    unlistProduct(jwt: unknown, input: unknown) {
      return authorized(jwt, productIdInput, input, (_actor, { id }) => updateById(id, { listed: false }));
    },

    /**
     * 重新上架：已上架時也回成功（冪等，不重設上架時間）。
     * 沒有圖片回 `no_images`、沒有分類回 `no_category`；兩者都缺時先回 `no_images`。
     * 從下架變上架時，上架時間設為現在。
     */
    relistProduct(jwt: unknown, input: unknown) {
      return authorized(jwt, productIdInput, input, async (_actor, { id }) => {
        const updated = await db.update(products).set({
          listed: true,
          listedAt: sql`case when ${products.listed} and ${products.listedAt} is not null then ${products.listedAt} else ${clock.now()} end`,
        }).where(and(
          eq(products.id, id),
          isNotNull(products.categoryId),
          sql`exists (select 1 from product_images where product_id = ${products.id})`,
        )).returning({ id: products.id });
        if (updated.length) return ok({ id });
        const [product] = await db.select({
          // 單表 select 會把 sql 片段裡的欄位去掉資料表前綴，子查詢裡就會誤指向 product_images.id，所以寫成 ${products}.id
          hasImages: sql<number>`exists (select 1 from product_images where product_id = ${products}.id)`.mapWith(Boolean),
        }).from(products).where(eq(products.id, id));
        if (!product) return fail("product_not_found");
        return product.hasImages ? fail("no_category") : fail("no_images");
      });
    },

    /** 庫存調整：只接受增減量，不能覆寫成某個數字。 */
    adjustStock(jwt: unknown, input: unknown) {
      return authorized(jwt, adjustStockInput, input, (_actor, { id, delta }) => adjustOnHand(db, id, delta));
    },

    /** 所有訂單，可依訂單狀態篩選；新的在前，最多 200 筆。 */
    listOrdersForAdmin(jwt: unknown, input: unknown) {
      return authorized(jwt, listOrdersInput, input, async (_actor, { status }) => ok(await selectOrdersForAdmin(db, status)));
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
        const order = await selectOrderForAdmin(db, orderId);
        if (!order) return fail("order_not_found");
        return ok({ ...order, payments: await selectOrderPaymentSummaries(db, clock.now(), orderId) });
      });
    },
  };
}
