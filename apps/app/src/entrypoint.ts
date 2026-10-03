import { WorkerEntrypoint } from "cloudflare:workers";
import { createAuth, type Auth } from "./auth/auth";
import { AuthConfigError, parseAuthConfig } from "./auth/config";
import { AUTH_PATH_PREFIX } from "./auth/paths";
import { readCustomerSession } from "./auth/session";
import { createAddressService } from "./addresses/service";
import { createAdminService } from "./admin/service";
import { createCatalogService } from "./catalog/service";
import { createContactService } from "./contact/service";
import { createInvoiceService } from "./invoices/service";
import { createOrderService } from "./orders/service";
import { readPaymentConfig } from "./payments/config";
import { createPaymentService } from "./payments/service";
import { cleanupDeletedProductImages } from "./images/manage";
import { systemClock } from "./shared/clock";

/**
 * App Worker 對外的介面：Web Worker 經 Service Binding 呼叫這些 RPC 方法。
 * 業務方法回傳 `Result`，業務拒絕以具名 reason 表達；`getCustomerSession` 是例外：
 * 「不是顧客」是常態而不是拒絕，且要一併帶回 Set-Cookie，所以回傳 `CustomerSessionLookup`。
 * `fetch` 只處理 `/api/auth/`，回傳 Better Auth 的 Response。
 */
export class AppEntrypoint extends WorkerEntrypoint<Env> {
  #catalog() {
    return createCatalogService(this.env.DB);
  }

  #admin() {
    return createAdminService(this.env.DB, systemClock, {
      teamDomain: this.env.ACCESS_TEAM_DOMAIN,
      audience: this.env.ACCESS_AUD,
      jwksJson: this.env.ACCESS_JWKS_JSON,
    }, {
      images: this.env.PRODUCT_IMAGES,
      reconcilePayment: (paymentId, actor) => this.#payments().reconcilePayment(paymentId, actor),
      retryRefund: (refundId, actor) => this.#payments().retryRefund(refundId, actor),
      retryInvoice: (invoiceId, actor) => this.#invoices().retryInvoice(invoiceId, actor),
      retryAllowance: (refundId, actor) => this.#invoices().retryAllowance(refundId, actor),
    });
  }

  /** 顧客 RPC：以 cookie 換顧客身分（session 由 Better Auth 判斷），沒有有效 session 一律 unauthorized。 */
  #orders() {
    return createOrderService(
      this.env.DB,
      systemClock,
      async (cookie) => {
        const { customer } = await readCustomerSession(this.#auth(), cookie);
        return customer?.customerId ?? null;
      },
      // 取消訂單才需要付款（閘道設定在那時才讀，Cron 與列表不受付款設定影響）
      (orderId) => this.#payments().invalidatePendingPayments(orderId),
    );
  }

  /** 顧客的聯絡 email 與模擬信箱：與訂單同樣以 cookie 換顧客身分。 */
  #contact() {
    return createContactService(this.env.DB, systemClock, async (cookie) => {
      const { customer } = await readCustomerSession(this.#auth(), cookie);
      return customer?.customerId ?? null;
    });
  }

  /** 顧客的地址簿：與訂單同樣以 cookie 換顧客身分。 */
  #addresses() {
    return createAddressService(this.env.DB, systemClock, async (cookie) => {
      const { customer } = await readCustomerSession(this.#auth(), cookie);
      return customer?.customerId ?? null;
    });
  }

  /** 模擬發票服務與金流閘道同一組設定：不全時 `gateway` 是 null，補辦回 `payment_unavailable`，開立義務仍留著。 */
  #invoices() {
    const config = readPaymentConfig(this.env);
    return createInvoiceService(this.env.DB, systemClock, config.ok ? config.config.invoices : null);
  }

  /**
   * 付款設定（閘道網址、API 金鑰）在這裡才驗證：不全時 `gateway` 是 null，付款 RPC 回 `payment_unavailable`，
   * 其他 RPC 不受影響。log 只含變數名稱，不含值。
   */
  #payments() {
    const config = readPaymentConfig(this.env);
    if (!config.ok) console.error(JSON.stringify({ event: "payment_config_invalid", invalid: config.invalid }));
    const authenticate = async (cookie: string) => {
      const { customer } = await readCustomerSession(this.#auth(), cookie);
      return customer?.customerId ?? null;
    };
    return createPaymentService(this.env.DB, systemClock, authenticate, config.ok ? config.config.gateway : null, config.ok ? config.config.webOrigin : "", createInvoiceService(this.env.DB, systemClock, config.ok ? config.config.invoices : null));
  }

  /**
   * 顧客登入的設定在這裡才驗證，不在模組載入時：設定缺漏只讓 auth 路徑失敗，catalog 與管理 RPC 照常運作
   * （Holdfast ADR 0008，https://github.com/CarlLee1983/Holdfast/blob/main/docs/adr/0008-better-auth-in-app-worker.md）。
   * 失敗時記一行只含變數名稱的 log 再丟出。
   */
  #auth() {
    try {
      return createAuth(parseAuthConfig(this.env), this.env.DB);
    } catch (error) {
      if (error instanceof AuthConfigError) {
        console.error(JSON.stringify({ event: "auth_config_invalid", error: error.message }));
      }
      throw error;
    }
  }

  /** Web Worker 把 `/api/auth/*` 原封轉來；App 沒有其他 HTTP 入口。 */
  fetch(request: Request): Promise<Response> | Response {
    if (!new URL(request.url).pathname.startsWith(AUTH_PATH_PREFIX)) {
      return new Response("Not Found", { status: 404 });
    }
    let auth: Auth;
    try {
      auth = this.#auth();
    } catch (error) {
      if (error instanceof AuthConfigError) return new Response("Service Unavailable", { status: 503 });
      throw error;
    }
    return auth.handler(request);
  }

  /** 以瀏覽器的 cookie 換顧客資訊；不是顧客時 `customer` 為 null。`setCookies` 要原樣附加到回給瀏覽器的回應。 */
  async getCustomerSession(cookie: string) {
    return readCustomerSession(this.#auth(), cookie);
  }

  /**
   * 每分鐘的 Cron（wrangler.jsonc 的 triggers）：先補查漏掉通知的待付款付款，再把超過付款期限的待付款訂單轉為已逾期，釋放保留。冪等。
   * 補查在逾期之前：期限內已付款的訂單先轉為已付款，不必走遲到付款；補查出錯只記 log，不擋逾期與圖片清理。
   */
  async scheduled(_controller: ScheduledController): Promise<void> {
    try {
      await this.#payments().reconcileDuePayments();
    } catch (error) {
      console.error(JSON.stringify({ event: "payment_reconcile_failed", error: error instanceof Error ? error.message : String(error) }));
    }
    await this.#orders().expireOverdueOrders();
    await cleanupDeletedProductImages(this.env.DB, this.env.PRODUCT_IMAGES);
  }

  getProduct(input: unknown) {
    return this.#catalog().getProduct(input);
  }

  listProducts(input?: unknown) {
    return this.#catalog().listProducts(input);
  }

  getStorefrontNav() {
    return this.#catalog().getStorefrontNav();
  }

  getFeaturedProducts() {
    return this.#catalog().getFeaturedProducts();
  }

  listCategories() {
    return this.#catalog().listCategories();
  }

  getCategory(input: unknown) {
    return this.#catalog().getCategory(input);
  }

  // 顧客 RPC：第一個參數是瀏覽器的 cookie，由 App 自行驗 session，不信任呼叫端的任何身分聲明。
  getShippingQuote(input: unknown) {
    return this.#catalog().getShippingQuote(input);
  }

  checkout(cookie: string, input: unknown) {
    return this.#orders().checkout(cookie, input);
  }

  listMyOrders(cookie: string) {
    return this.#orders().listMyOrders(cookie);
  }

  getMyOrder(cookie: string, input: unknown) {
    return this.#orders().getMyOrder(cookie, input);
  }

  cancelOrder(cookie: string, input: unknown) {
    return this.#orders().cancelOrder(cookie, input);
  }

  requestCancellation(cookie: string, input: unknown) {
    return this.#orders().requestCancellation(cookie, input);
  }

  requestReturn(cookie: string, input: unknown) {
    return this.#orders().requestReturn(cookie, input);
  }

  getMyContact(cookie: string) {
    return this.#contact().getMyContact(cookie);
  }

  requestContactEmail(cookie: string, input: unknown) {
    return this.#contact().requestContactEmail(cookie, input);
  }

  verifyContactEmail(cookie: string, input: unknown) {
    return this.#contact().verifyContactEmail(cookie, input);
  }

  listMyMail(cookie: string) {
    return this.#contact().listMyMail(cookie);
  }

  getMyMail(cookie: string, input: unknown) {
    return this.#contact().getMyMail(cookie, input);
  }

  listMyAddresses(cookie: string) {
    return this.#addresses().listMyAddresses(cookie);
  }

  addAddress(cookie: string, input: unknown) {
    return this.#addresses().addAddress(cookie, input);
  }

  updateAddress(cookie: string, input: unknown) {
    return this.#addresses().updateAddress(cookie, input);
  }

  deleteAddress(cookie: string, input: unknown) {
    return this.#addresses().deleteAddress(cookie, input);
  }

  startPayment(cookie: string, input: unknown) {
    return this.#payments().startPayment(cookie, input);
  }

  confirmPayment(cookie: string, input: unknown) {
    return this.#payments().confirmPayment(cookie, input);
  }

  /** 套用付款結果（冪等）。呼叫端（Web Worker）必須先驗過閘道 webhook 的簽章；這個方法本身不驗任何身分。 */
  applyPaymentResult(input: unknown) {
    return this.#payments().applyPaymentResult(input);
  }

  // 管理 RPC：第一個參數是 Cloudflare Access 的原始 JWT，由 App 自行驗簽，
  // 不信任呼叫端的任何身分聲明。輸入以 unknown 接收，在邊界驗證。
  listProductsForAdmin(jwt: string) {
    return this.#admin().listProductsForAdmin(jwt);
  }

  getProductForAdmin(jwt: string, input: unknown) {
    return this.#admin().getProductForAdmin(jwt, input);
  }

  createCategory(jwt: string, input: unknown) {
    return this.#admin().createCategory(jwt, input);
  }

  updateCategory(jwt: string, input: unknown) {
    return this.#admin().updateCategory(jwt, input);
  }

  setCategoryImage(jwt: string, input: unknown) {
    return this.#admin().setCategoryImage(jwt, input);
  }

  deleteCategory(jwt: string, input: unknown) {
    return this.#admin().deleteCategory(jwt, input);
  }

  getCategoryForAdmin(jwt: string, input: unknown) {
    return this.#admin().getCategoryForAdmin(jwt, input);
  }

  listCategoriesForAdmin(jwt: string) {
    return this.#admin().listCategoriesForAdmin(jwt);
  }

  setProductOptions(jwt: string, input: unknown) {
    return this.#admin().setProductOptions(jwt, input);
  }

  createVariant(jwt: string, input: unknown) {
    return this.#admin().createVariant(jwt, input);
  }

  updateVariant(jwt: string, input: unknown) {
    return this.#admin().updateVariant(jwt, input);
  }

  getShippingRates(jwt: string) {
    return this.#admin().getShippingRates(jwt);
  }

  setShippingRate(jwt: string, input: unknown) {
    return this.#admin().setShippingRate(jwt, input);
  }

  setVariantDiscontinued(jwt: string, input: unknown) {
    return this.#admin().setVariantDiscontinued(jwt, input);
  }

  setProductFeatured(jwt: string, input: unknown) {
    return this.#admin().setProductFeatured(jwt, input);
  }

  createProduct(jwt: string, input: unknown) {
    return this.#admin().createProduct(jwt, input);
  }

  addProductImage(jwt: string, input: unknown) {
    return this.#admin().addProductImage(jwt, input);
  }

  reorderProductImages(jwt: string, input: unknown) {
    return this.#admin().reorderProductImages(jwt, input);
  }

  deleteProductImage(jwt: string, input: unknown) {
    return this.#admin().deleteProductImage(jwt, input);
  }

  updateProduct(jwt: string, input: unknown) {
    return this.#admin().updateProduct(jwt, input);
  }

  unlistProduct(jwt: string, input: unknown) {
    return this.#admin().unlistProduct(jwt, input);
  }

  relistProduct(jwt: string, input: unknown) {
    return this.#admin().relistProduct(jwt, input);
  }

  adjustStock(jwt: string, input: unknown) {
    return this.#admin().adjustStock(jwt, input);
  }

  listLowStockVariants(jwt: string) {
    return this.#admin().listLowStockVariants(jwt);
  }

  listStockMovements(jwt: string, input: unknown) {
    return this.#admin().listStockMovements(jwt, input);
  }

  listOrdersForAdmin(jwt: string, input: unknown) {
    return this.#admin().listOrdersForAdmin(jwt, input);
  }

  exportOrdersForAdmin(jwt: string, input: unknown) {
    return this.#admin().exportOrdersForAdmin(jwt, input);
  }

  addOrderNote(jwt: string, input: unknown) {
    return this.#admin().addOrderNote(jwt, input);
  }

  getOrderForAdmin(jwt: string, input: unknown) {
    return this.#admin().getOrderForAdmin(jwt, input);
  }

  listPaymentsToReconcile(jwt: string) {
    return this.#admin().listPaymentsToReconcile(jwt);
  }

  reconcilePayment(jwt: string, input: unknown) {
    return this.#admin().reconcilePayment(jwt, input);
  }

  listRefundsToHandle(jwt: string) {
    return this.#admin().listRefundsToHandle(jwt);
  }

  retryRefund(jwt: string, input: unknown) {
    return this.#admin().retryRefund(jwt, input);
  }

  listInvoicesToHandle(jwt: string) {
    return this.#admin().listInvoicesToHandle(jwt);
  }

  retryInvoice(jwt: string, input: unknown) {
    return this.#admin().retryInvoice(jwt, input);
  }

  resendInvoice(jwt: string, input: unknown) {
    return this.#admin().resendInvoice(jwt, input);
  }

  retryAllowance(jwt: string, input: unknown) {
    return this.#admin().retryAllowance(jwt, input);
  }

  resendAllowance(jwt: string, input: unknown) {
    return this.#admin().resendAllowance(jwt, input);
  }

  listCancellationsToReview(jwt: string) {
    return this.#admin().listCancellationsToReview(jwt);
  }

  decideCancellation(jwt: string, input: unknown) {
    return this.#admin().decideCancellation(jwt, input);
  }

  listReturnsToHandle(jwt: string) {
    return this.#admin().listReturnsToHandle(jwt);
  }

  decideReturn(jwt: string, input: unknown) {
    return this.#admin().decideReturn(jwt, input);
  }

  recordReturnReceipt(jwt: string, input: unknown) {
    return this.#admin().recordReturnReceipt(jwt, input);
  }

  recordReturnInspection(jwt: string, input: unknown) {
    return this.#admin().recordReturnInspection(jwt, input);
  }

  scrapUnavailableStock(jwt: string, input: unknown) {
    return this.#admin().scrapUnavailableStock(jwt, input);
  }

  listMailForAdmin(jwt: string) {
    return this.#admin().listMailForAdmin(jwt);
  }

  resendMail(jwt: string, input: unknown) {
    return this.#admin().resendMail(jwt, input);
  }

  setMailDeliveryFailure(jwt: string, input: unknown) {
    return this.#admin().setMailDeliveryFailure(jwt, input);
  }

  shipOrder(jwt: string, input: unknown) {
    return this.#admin().shipOrder(jwt, input);
  }

  recordShipmentEvent(jwt: string, input: unknown) {
    return this.#admin().recordShipmentEvent(jwt, input);
  }

  confirmShipmentLoss(jwt: string, input: unknown) {
    return this.#admin().confirmShipmentLoss(jwt, input);
  }

  declareShipmentReturn(jwt: string, input: unknown) {
    return this.#admin().declareShipmentReturn(jwt, input);
  }

  recordShipmentReturnReceipt(jwt: string, input: unknown) {
    return this.#admin().recordShipmentReturnReceipt(jwt, input);
  }

  recordShipmentReturnInspection(jwt: string, input: unknown) {
    return this.#admin().recordShipmentReturnInspection(jwt, input);
  }
}

export default AppEntrypoint;
