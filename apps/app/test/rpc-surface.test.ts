import { describe, expect, it } from "vitest";
import { AppEntrypoint } from "../src/entrypoint";

// 呼叫不存在的 RPC 方法會讓 workerd 噴出未處理錯誤，所以直接檢查對外介面的方法名稱。
// 新增 RPC 方法時必須顯式更新這份白名單（顧客 RPC 的第一個參數是 cookie，一律由 App 驗 session）：不得出現刪除商品（商品只能下架）、覆寫在庫數（只能增減），
// 或任何測試用的登入方法（production 沒有測試登入路徑；Holdfast ADR 0013）。
const RPC_METHODS = [
  "addAddress",
  "addProductImage",
  "adjustStock",
  "applyPaymentResult",
  "cancelOrder",
  "checkout",
  "confirmPayment",
  "createCategory",
  "createProduct",
  "createVariant",
  "deleteAddress",
  "deleteCategory",
  "deleteProductImage",
  "fetch",
  "getCategory",
  "getCategoryForAdmin",
  "getCustomerSession",
  "getFeaturedProducts",
  "getMyContact",
  "getMyMail",
  "getMyOrder",
  "getOrderForAdmin",
  "getProduct",
  "getProductForAdmin",
  "getShippingQuote",
  "getShippingRates",
  "getStorefrontNav",
  "listCategories",
  "listCategoriesForAdmin",
  "listMailForAdmin",
  "listMyAddresses",
  "listMyMail",
  "listMyOrders",
  "listOrdersForAdmin",
  "listProducts",
  "listProductsForAdmin",
  "listStockMovements",
  "relistProduct",
  "reorderProductImages",
  "requestContactEmail",
  "resendMail",
  "scheduled",
  "setCategoryImage",
  "setMailDeliveryFailure",
  "setProductFeatured",
  "setProductOptions",
  "setShippingRate",
  "setVariantDiscontinued",
  "shipOrder",
  "startPayment",
  "unlistProduct",
  "updateAddress",
  "updateCategory",
  "updateProduct",
  "updateVariant",
  "verifyContactEmail",
];

describe("RPC 介面", () => {
  it("方法名稱符合白名單", () => {
    const methods = Object.getOwnPropertyNames(AppEntrypoint.prototype).filter((name) => name !== "constructor");
    expect(methods.sort()).toEqual(RPC_METHODS);
  });
});
