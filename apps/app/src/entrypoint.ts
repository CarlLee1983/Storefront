import { WorkerEntrypoint } from "cloudflare:workers";
import { createAdminService } from "./admin/service";
import { createCatalogService } from "./catalog/service";
import { systemClock } from "./shared/clock";

/**
 * App Worker 對外的介面：Web Worker 經 Service Binding 呼叫這些 RPC 方法。
 * 業務方法回傳 `Result`，業務拒絕以具名 reason 表達。`fetch` 沒有任何 HTTP 入口。
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

  fetch(_request: Request): Response {
    return new Response("Not Found", { status: 404 });
  }

  listProducts() {
    return this.#catalog().listProducts();
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
}

export default AppEntrypoint;
