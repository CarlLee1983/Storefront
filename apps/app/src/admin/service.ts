import { and, eq, isNotNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { z } from "zod";
import { selectProductForAdmin, selectProductsForAdmin } from "../catalog/queries";
import { productVariants, products } from "../catalog/schema";
import { adjustOnHand } from "../catalog/stock";
import { createVariant, setProductOptions, setVariantDiscontinued, updateVariant } from "../catalog/variants";
import { deliverNoticeSafely } from "../contact/notify";
import { resendMessage, selectMailForAdmin, setDeliveryFailure } from "../contact/admin";
import { mailMessageIdInput, setMailDeliveryFailureInput } from "../contact/input";
import { categoryIdInput, createCategoryInput, updateCategoryInput } from "../categories/input";
import { deleteCategory, setCategoryImage } from "../categories/manage";
import { isValidSlug } from "../categories/slug";
import { categoryExists, insertCategory, selectCategoriesForAdmin, selectCategoryForAdmin, updateCategoryById } from "../categories/queries";
import { addProductImageInput, reorderProductImagesInput, deleteProductImageInput, setCategoryImageInput } from "../images/input";
import { reorderProductImages, deleteProductImage } from "../images/manage";
import { uploadProductImage, type ProductImageBucket } from "../images/upload";
import { selectStockMovements } from "../stock/ledger";
import { selectShippingRates, updateShippingRate } from "../shipping/queries";
import { selectOrdersForAdmin } from "../orders/admin-queries";
import { orderIdInput } from "../orders/input";
import { selectOrderForAdmin } from "../orders/queries";
import { dispatchShipment } from "../shipments/dispatch";
import { recordShipmentEvent } from "../shipments/events";
import { selectOrderPaymentSummaries } from "../payments/queries";
import type { createPaymentService } from "../payments/service";
import { reconcilePaymentInput, retryRefundInput } from "../payments/input";
import { selectReconcileListing } from "../payments/reconcile";
import { selectOrderRefunds, selectRefundTodos } from "../payments/refunds";
import type { Clock } from "../shared/clock";
import { parseInput } from "../shared/input";
import { fail, ok, type InvalidInput, type ProductNotFound, type Unauthorized } from "../shared/result";
import { createAccessVerifier, type AccessConfig, type AccessIdentity } from "./access";
import { adjustStockInput, createProductInput, createVariantInput, listOrdersInput, listStockMovementsInput, productIdInput, recordShipmentEventInput, setProductFeaturedInput, setProductOptionsInput, setShippingRateInput, setVariantDiscontinuedInput, shipOrderInput, updateProductInput, updateVariantInput } from "./input";

/** 補查一筆付款（見 `createPaymentService().reconcilePayment`）；由 entrypoint 接上，管理服務自己不碰金流閘道。 */
export type ReconcilePayment = ReturnType<typeof createPaymentService>["reconcilePayment"];

/** 重試一筆退款（見 `createPaymentService().retryRefund`）；同樣由 entrypoint 接上。 */
export type RetryRefund = ReturnType<typeof createPaymentService>["retryRefund"];

export interface AdminDependencies {
  images?: ProductImageBucket;
  reconcilePayment: ReconcilePayment;
  retryRefund: RetryRefund;
}

export function createAdminService(d1: D1Database, clock: Clock, access: AccessConfig, { images, reconcilePayment, retryRefund }: AdminDependencies) {
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

    /** 新增商品，預設下架；同時建立它的預設變體（售價由輸入帶入，在庫數 0），兩者同一個 batch，全有或全無。 */
    createProduct(jwt: unknown, input: unknown) {
      return authorized(jwt, createProductInput, input, async (_actor, { priceTwd, deliveryType, ...data }) => {
        const [[row]] = await db.batch([
          db.insert(products).values({ ...data, listed: false }).returning({ id: products.id }),
          db.insert(productVariants).values({ productId: sql`last_insert_rowid()`, isDefault: true, priceTwd, deliveryType }),
        ]);
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
     * 修改名稱、說明、分類，以及預設變體的單價與原價；不動上架狀態。
     * 指定的分類不存在回 `category_not_found`；上架中的商品不能把分類清成空，回 `no_category`（下架中的可以）。
     * 原價必須高於「儲存後」的售價，否則回 `invalid_compare_at_price`：不帶原價時比對既有原價，帶 `null` 則是清空，所以同時把售價改回並清空原價是合法的。
     */
    updateProduct(jwt: unknown, input: unknown) {
      return authorized(jwt, updateProductInput, input, async (_actor, { id, priceTwd, compareAtPriceTwd, deliveryType, ...productValues }) => {
        if (typeof productValues.categoryId === "number" && !(await categoryExists(db, productValues.categoryId))) return fail("category_not_found");
        // 商品不存在優先於原價檢查：先確認存在，才有「原價不合法」可說
        const [existing] = await db.select({ id: products.id }).from(products).where(eq(products.id, id));
        if (!existing) return fail("product_not_found");
        if (typeof compareAtPriceTwd === "number" && compareAtPriceTwd <= priceTwd) return fail("invalid_compare_at_price");
        const clearsCategory = productValues.categoryId === null;
        // 不帶原價時沿用既有原價，所以「原價仍高於新售價」也寫進 UPDATE 的條件
        const keepsCompareAt = compareAtPriceTwd === undefined;
        const defaultVariantKeepsCompareAt = sql`exists (
          select 1 from product_variants kept where kept.product_id = ${id} and kept.is_default = 1
            and (kept.compare_at_price_twd is null or kept.compare_at_price_twd > ${priceTwd})
        )`;
        // 商品欄位與預設變體的價格在同一個 batch；兩句帶著同一組條件（「上架中不能清空分類」、「原價仍高於新售價」），
        // 條件對兩句的判定相同，所以要嘛都寫入、要嘛都不寫，不會和同時發生的上架互相穿插
        const [updatedVariant, updatedProduct] = await db.batch([
          db.update(productVariants)
            .set({ priceTwd, ...(compareAtPriceTwd === undefined ? {} : { compareAtPriceTwd }), ...(deliveryType === undefined ? {} : { deliveryType }) })
            .where(and(
              eq(productVariants.productId, id),
              eq(productVariants.isDefault, true),
              clearsCategory ? sql`exists (select 1 from products listed_check where listed_check.id = ${id} and listed_check.listed = 0)` : undefined,
              keepsCompareAt ? defaultVariantKeepsCompareAt : undefined,
            ))
            .returning({ id: productVariants.id }),
          db.update(products).set(productValues)
            .where(and(
              eq(products.id, id),
              clearsCategory ? eq(products.listed, false) : undefined,
              keepsCompareAt ? defaultVariantKeepsCompareAt : undefined,
            ))
            .returning({ id: products.id }),
        ]);
        if (updatedVariant.length && updatedProduct.length) return ok({ id });
        const [variant] = await db.select({ compareAtPriceTwd: productVariants.compareAtPriceTwd }).from(productVariants)
          .where(and(eq(productVariants.productId, id), eq(productVariants.isDefault, true)));
        if (!variant) return fail("product_not_found");
        return keepsCompareAt && variant.compareAtPriceTwd !== null && variant.compareAtPriceTwd <= priceTwd
          ? fail("invalid_compare_at_price")
          : fail("no_category");
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

    /**
     * 切換精選：標為精選時記下現在的時間，取消時清空；已是精選再標一次不更新時間（冪等）。
     * 下架商品也可以切換，只是不會出現在首頁。
     */
    setProductFeatured(jwt: unknown, input: unknown) {
      return authorized(jwt, setProductFeaturedInput, input, async (_actor, { id, featured }) => {
        const updated = await db.update(products)
          .set({ featuredAt: featured ? sql`coalesce(${products.featuredAt}, ${clock.now()})` : null })
          .where(eq(products.id, id)).returning({ id: products.id });
        return updated.length === 0 ? fail("product_not_found") : ok({ id });
      });
    },

    /** 設定選項維度名稱（最多兩個）；個數改變時商品只能有一個變體，並以 `defaultVariantValues` 重設它的選項值。 */
    setProductOptions(jwt: unknown, input: unknown) {
      return authorized(jwt, setProductOptionsInput, input, (_actor, data) => setProductOptions(db, data));
    },

    /** 新增變體（選項值組合不可與同商品的變體重複，個數須等於維度個數）；在庫數 0，由庫存調整補貨。 */
    createVariant(jwt: unknown, input: unknown) {
      return authorized(jwt, createVariantInput, input, (_actor, data) => createVariant(db, data));
    },

    /** 修改變體的選項值、售價、原價與指定圖片。 */
    updateVariant(jwt: unknown, input: unknown) {
      return authorized(jwt, updateVariantInput, input, (_actor, data) => updateVariant(db, data));
    },

    /** 目前兩類配送的費率。 */
    async getShippingRates(jwt: unknown) {
      const auth = await verifier.verify(jwt);
      if (!auth.ok) return auth;
      return ok(await selectShippingRates(db));
    },

    /** 調整某配送類型的費率；只影響之後成立的訂單，舊單的實收運費是快照，不變。 */
    setShippingRate(jwt: unknown, input: unknown) {
      return authorized(jwt, setShippingRateInput, input, async (_actor, { deliveryType, feeTwd }) => ok(await updateShippingRate(db, deliveryType, feeTwd)));
    },

    /** 停賣或恢復販售變體：停賣後不接受新購買，變體與歷史保留；重複操作冪等。 */
    setVariantDiscontinued(jwt: unknown, input: unknown) {
      return authorized(jwt, setVariantDiscontinuedInput, input, (_actor, { variantId, discontinued }) => setVariantDiscontinued(db, variantId, discontinued, clock.now()));
    },

    /** 庫存調整：只接受增減量與原因，不能覆寫成某個數字；操作人、時間與原因寫進庫存流水。 */
    adjustStock(jwt: unknown, input: unknown) {
      return authorized(jwt, adjustStockInput, input, (actor, { variantId, delta, reason }) => adjustOnHand(d1, { variantId, delta, reason, actor: actor.email }, clock.now()));
    },

    /** 庫存流水（在庫數的每一次變動），新的在前；可依變體或訂單篩選，以 `nextBeforeId` 游標往舊的翻頁。 */
    listStockMovements(jwt: unknown, input: unknown) {
      return authorized(jwt, listStockMovementsInput, input, async (_actor, query) => ok(await selectStockMovements(db, query)));
    },

    /** 所有訂單，可依訂單狀態篩選；新的在前，最多 200 筆。 */
    listOrdersForAdmin(jwt: unknown, input: unknown) {
      return authorized(jwt, listOrdersInput, input, async (_actor, { status }) => ok(await selectOrdersForAdmin(db, status)));
    },

    /**
     * 交運一批（Shipment）：指定訂單明細與本批數量，扣這批的實體在庫並消耗對應的已付款保留，物流單號可以不附；
     * 含大型配送明細的批次必須帶議定時段。訂單依各明細已交運數量轉為部分出貨或已出貨，分批不追加運費。
     * 同一冪等鍵重送回原批次（`replayed: true`），不重複扣庫與通知。
     * 訂單不是已付款或部分出貨回 `order_not_shippable`，不存在回 `order_not_found`，數量超過未交運數量回 `shipment_quantity_exceeded`。
     */
    shipOrder(jwt: unknown, input: unknown) {
      return authorized(jwt, shipOrderInput, input, async (actor, request) => {
        const result = await dispatchShipment(d1, db, { ...request, actor: actor.email }, clock.now());
        if (result.ok) {
          console.log(JSON.stringify({ event: "shipment_dispatched", orderId: request.orderId, shipmentId: result.data.shipmentId, actor: actor.email, replayed: result.data.replayed }));
          // 信件本體已在交運 batch 內寫好；投遞出錯不影響交運，重送同一批時會補上首次投遞
          await deliverNoticeSafely(db, `shipment:${result.data.shipmentId}`, clock.now());
        }
        return result;
      });
    },

    /**
     * 記錄一筆物流回報（模擬物流）：送達、配送失敗、再次配送；進度與實際送達時間由全部回報推導（見 `recordShipmentEvent`）。
     * 同一事件鍵重送回 `replayed: true` 並補回遺失的通知；批次不存在回 `shipment_not_found`，
     * 發生時間早於交運或晚於現在回 `event_time_invalid`，同鍵不同內容回 `event_key_conflict`。
     */
    recordShipmentEvent(jwt: unknown, input: unknown) {
      return authorized(jwt, recordShipmentEventInput, input, async (actor, request) => {
        const result = await recordShipmentEvent(d1, db, { ...request, actor: actor.email }, clock.now());
        if (result.ok) {
          console.log(JSON.stringify({ event: "shipment_event_recorded", shipmentId: request.shipmentId, eventKey: request.eventKey, kind: request.kind, actor: actor.email, replayed: result.data.replayed }));
          // 信件本體已在同一個 batch 內寫好；投遞出錯不影響記錄，同一回報重送時會補上首次投遞
          await deliverNoticeSafely(db, `shipment_delivered:${request.shipmentId}`, clock.now());
          await deliverNoticeSafely(db, `shipment_delivery_failed:${request.shipmentId}:${request.eventKey}`, clock.now());
        }
        return result;
      });
    },

    /** 模擬信箱的投遞結果與演練控制狀態（不含信件內文與驗證連結）。 */
    async listMailForAdmin(jwt: unknown) {
      const auth = await verifier.verify(jwt);
      if (!auth.ok) return auth;
      return ok(await selectMailForAdmin(db, clock.now()));
    },

    /** 重送一封信（同一封信的新投遞）；驗證已失效的驗證信回 `message_not_resendable`，沒有已驗證地址的通知回 `no_verified_contact`。 */
    resendMail(jwt: unknown, input: unknown) {
      return authorized(jwt, mailMessageIdInput, input, (actor, { messageId }) => resendMessage(db, clock, actor.email, messageId));
    },

    /** 開關模擬信箱的「投遞失敗」演練：開啟後之後的每次投遞都失敗，直到關閉。 */
    setMailDeliveryFailure(jwt: unknown, input: unknown) {
      return authorized(jwt, setMailDeliveryFailureInput, input, (actor, { enabled }) => setDeliveryFailure(db, clock, actor.email, enabled));
    },

    /** 本地仍是 pending 的付款與它們開著的補查待辦（Cron 或管理員補查沒能確認結果）。 */
    async listPaymentsToReconcile(jwt: unknown) {
      const auth = await verifier.verify(jwt);
      if (!auth.ok) return auth;
      return ok(await selectReconcileListing(db));
    },

    /** 補查一筆付款：向閘道查證並套用結果（與 webhook 同一條套用路徑）。 */
    reconcilePayment(jwt: unknown, input: unknown) {
      return authorized(jwt, reconcilePaymentInput, input, (actor, { paymentId }) => reconcilePayment(paymentId, actor.email));
    },

    /** 退款待辦：所有尚未成功的退款（結果不明、明確失敗、等待與處理中），含每次嘗試的紀錄與操作者。 */
    async listRefundsToHandle(jwt: unknown) {
      const auth = await verifier.verify(jwt);
      if (!auth.ok) return auth;
      return ok(await selectRefundTodos(db, clock.now()));
    },

    /** 重試一筆退款：明確失敗的直接重送，結果不明的先向閘道查證再決定；操作者記在嘗試紀錄上。 */
    retryRefund(jwt: unknown, input: unknown) {
      return authorized(jwt, retryRefundInput, input, (actor, { refundId }) => retryRefund(refundId, actor.email));
    },

    /** 單張訂單的明細：訂單明細快照、收件資訊、所有付款嘗試、物流單號與出貨時間。 */
    getOrderForAdmin(jwt: unknown, input: unknown) {
      return authorized(jwt, orderIdInput, input, async (_actor, { orderId }) => {
        const order = await selectOrderForAdmin(db, orderId);
        if (!order) return fail("order_not_found");
        return ok({ ...order, payments: await selectOrderPaymentSummaries(db, clock.now(), orderId), refunds: await selectOrderRefunds(db, orderId) });
      });
    },
  };
}
