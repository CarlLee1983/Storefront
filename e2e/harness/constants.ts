/**
 * E2E 的固定設定。受測伺服器（serve.ts）與測試（Playwright worker）是不同行程，
 * 兩邊要對同一組值達成一致，所以用常數而不是每次隨機產生。
 * 這裡的 secret 都是明顯的假值，只用於 E2E 專用、每次重建的本機狀態，不是任何環境的真值。
 */

/** 不用 Astro dev 的 4321 與閘道 dev 的 8787：避免和開發中的伺服器搶埠。 */
export const PORT = 8790;
export const GATEWAY_PORT = 8791;
/** wrangler 的 inspector 預設 9229，常被開發中的其他 dev server 佔用；固定成不常用的埠，啟動才不受本機其他行程影響。 */
export const WEB_INSPECTOR_PORT = 9330;
export const GATEWAY_INSPECTOR_PORT = 9331;

/** 瀏覽器看到的 Web origin：App 的 BETTER_AUTH_URL，閘道導回與 webhook 網址由它組成。 */
export const BASE_URL = `http://localhost:${PORT}`;
/** 模擬閘道的 origin：App 的 GATEWAY_BASE_URL，閘道回的付款頁網址也以它為準。 */
export const GATEWAY_URL = `http://localhost:${GATEWAY_PORT}`;

/**
 * serve.ts 從啟動到 Web 可連線的總預算，也是 Playwright `webServer.timeout`：
 * 涵蓋 Web 建置、兩個 D1 的 migration、閘道與 Web 的啟動。其中等閘道就緒只佔 GATEWAY_READY_TIMEOUT_MS，必須小於它。
 */
export const WEB_SERVER_TIMEOUT_MS = 180_000;
export const GATEWAY_READY_TIMEOUT_MS = 120_000;

/** Better Auth 的 secret：E2E 以它簽 session cookie（ADR 0013）。 */
export const AUTH_SECRET = "storefront-e2e-only-secret-not-for-any-real-env";
/** 閘道的 API 金鑰（App 呼叫閘道；/console 的 Basic 密碼）。 */
export const GATEWAY_API_KEY = "storefront-e2e-only-gateway-api-key";
/** 閘道簽 webhook、Web 驗簽用的同一把 secret。 */
export const GATEWAY_WEBHOOK_SECRET = "storefront-e2e-only-gateway-webhook-secret";

/** 測試會員與它的 session（直接寫入 E2E 的 D1，不經 OAuth）。 */
export const MEMBER = { id: "e2e-member", name: "E2E 會員", email: "e2e-member@members.storefront.invalid" } as const;
export const SESSION = { id: "e2e-session", token: "e2e-session-token" } as const;

/**
 * 管理者的 Access 身分：E2E 自己簽 JWT（admin-access.ts），audience 與寫進 App `.dev.vars` 的 ACCESS_AUD 一致。
 */
export const ADMIN_EMAIL = "e2e-admin@admin.storefront.invalid";
export const ADMIN_ACCESS_AUD = "storefront-e2e-audience";
