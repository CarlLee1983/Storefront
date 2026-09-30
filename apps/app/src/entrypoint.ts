import { WorkerEntrypoint } from "cloudflare:workers";
import { createAuth, type Auth } from "./auth/auth";
import { AuthConfigError, parseAuthConfig } from "./auth/config";
import { AUTH_PATH_PREFIX } from "./auth/paths";
import { readCustomerSession } from "./auth/session";
import { createAdminService } from "./admin/service";
import { createCatalogService } from "./catalog/service";
import { createOrderService } from "./orders/service";
import { readPaymentConfig } from "./payments/config";
import { createPaymentService } from "./payments/service";
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
    });
  }

  /** 顧客 RPC：以 cookie 換顧客身分（session 由 Better Auth 判斷），沒有有效 session 一律 unauthorized。 */
  #orders() {
    return createOrderService(this.env.DB, systemClock, async (cookie) => {
      const { customer } = await readCustomerSession(this.#auth(), cookie);
      return customer?.customerId ?? null;
    });
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
    return createPaymentService(this.env.DB, systemClock, authenticate, config.ok ? config.config.gateway : null, config.ok ? config.config.webOrigin : "");
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

  /** 每分鐘的 Cron（wrangler.jsonc 的 triggers）：把超過付款期限的待付款訂單轉為已逾期，釋放保留。冪等。 */
  async scheduled(_controller: ScheduledController): Promise<void> {
    await this.#orders().expireOverdueOrders();
  }

  listProducts() {
    return this.#catalog().listProducts();
  }

  // 顧客 RPC：第一個參數是瀏覽器的 cookie，由 App 自行驗 session，不信任呼叫端的任何身分聲明。
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

  createProduct(jwt: string, input: unknown) {
    return this.#admin().createProduct(jwt, input);
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

  listOrdersForAdmin(jwt: string, input: unknown) {
    return this.#admin().listOrdersForAdmin(jwt, input);
  }

  getOrderForAdmin(jwt: string, input: unknown) {
    return this.#admin().getOrderForAdmin(jwt, input);
  }

  shipOrder(jwt: string, input: unknown) {
    return this.#admin().shipOrder(jwt, input);
  }
}

export default AppEntrypoint;
