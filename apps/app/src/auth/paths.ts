/**
 * App 與 Web 共用的 Better Auth 路徑與 cookie 常數。這個檔案刻意不 import 任何東西：
 * Web 經 `@storefront/app/auth-paths`（package.json 的 exports）只打包這個檔案，
 * 不會把 App 的執行期程式碼（Better Auth、Drizzle）帶進 Web bundle。
 */

/** Better Auth 的 `basePath`；App 的 `fetch` 只處理這個前綴，Web 的 middleware 也只轉發這個前綴。 */
export const AUTH_BASE_PATH = "/api/auth";

export const AUTH_PATH_PREFIX = `${AUTH_BASE_PATH}/`;

/**
 * Better Auth 的 cookie 前綴（`advanced.cookiePrefix`）。session cookie 的名稱是
 * `<前綴>.session_token`，https 下再加 `__Secure-`；Web 的 `hasSessionCookie` 依此判斷要不要查 session。
 */
export const AUTH_COOKIE_PREFIX = "better-auth";
