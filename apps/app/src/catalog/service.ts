import { drizzle } from "drizzle-orm/d1";
import { categorySlugInput } from "../categories/input";
import { selectListedCategories, selectListedCategoryBySlug } from "../categories/queries";
import { parseInput } from "../shared/input";
import { shippingQuoteInput } from "../shipping/input";
import { selectShippingRates, selectVariantDeliveryTypes } from "../shipping/queries";
import { fail, ok } from "../shared/result";
import { availabilityInput, listProductsInput } from "./input";
import { selectAvailability, existsProductOnSale, selectFeaturedProducts, selectListedProduct, selectListedProducts, selectSitemapProductIds } from "./queries";

/** 前台讀取，不需登入。 */
export function createCatalogService(d1: D1Database) {
  const db = drizzle(d1);

  return {
    async getAvailability(input: unknown) {
      const parsed = parseInput(availabilityInput, input);
      if (!parsed.ok) return parsed;
      return ok({ variants: await selectAvailability(db, parsed.data.variantIds) });
    },
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
    /** sitemap 用：可收錄的商品編號（上架且至少一個販售中變體）；不需登入，只含公開資訊。 */
    async listSitemapProductIds() {
      return ok(await selectSitemapProductIds(db));
    },
    /** 首頁精選商品（最多 4 件，不足時以最新上架補滿）；沒有任何上架商品時為空陣列。 */
    async getFeaturedProducts() {
      return ok(await selectFeaturedProducts(db));
    },
    /**
     * 結帳畫面試算運費用：現行兩類費率，以及這些變體各自的配送類型（不存在的變體不出現）。
     * 費用由呼叫端按「含該類型就收一次」計算（`computeShippingFees`）；真正收取的金額仍由下單時重算並比對。不需登入。
     */
    async getShippingQuote(input: unknown) {
      const parsed = parseInput(shippingQuoteInput, input);
      if (!parsed.ok) return parsed;
      const [rates, variants] = await Promise.all([selectShippingRates(db), selectVariantDeliveryTypes(db, parsed.data.variantIds)]);
      return ok({ rates, variants });
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
