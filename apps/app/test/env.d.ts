import type { D1Migration } from "@cloudflare/vitest-pool-workers";

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
      /** 測試用 Access 簽章私鑰（JWK 字串），只存在於測試環境。 */
      TEST_ACCESS_PRIVATE_JWK: string;
    }
  }
}
