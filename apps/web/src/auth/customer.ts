import { AUTH_COOKIE_PREFIX, AUTH_PATH_PREFIX } from "@storefront/app/auth-paths";

/**
 * 只有 `/api/auth/` 底下的請求原封轉給 App Worker（Holdfast ADR 0008，https://github.com/CarlLee1983/Holdfast/blob/main/docs/adr/0008-better-auth-in-app-worker.md）。
 * 前綴來自 App 的 `src/auth/paths.ts`（與 Better Auth 的 `basePath` 同一個常數）；該檔案不 import 任何東西，
 * 所以這個執行期 import 只會把兩個字串常數打進 Web bundle。
 */
export function isAuthPath(pathname: string): boolean {
  return pathname.startsWith(AUTH_PATH_PREFIX);
}

/**
 * 轉給 App 的 auth 請求所帶的標頭：移除用戶端可自行指定的 `X-Forwarded-*`，App 的限流不信任它們；
 * 來源 IP 只認 `cf-connecting-ip`（Cloudflare 邊緣設定，Web 收到什麼就原樣帶什麼，沒有就不帶）。
 * 回傳新的 Headers，不改動輸入。
 */
export function forwardedAuthHeaders(incoming: Headers): Headers {
  const headers = new Headers(incoming);
  for (const name of [...headers.keys()]) {
    if (name.startsWith("x-forwarded-")) headers.delete(name);
  }
  return headers;
}

// 只用來判斷「解析後是不是仍在站內」，不會出現在結果裡
const SENTINEL_ORIGIN = "https://sentinel.invalid";

/**
 * 登入後要回去的路徑：只接受站內路徑，其他一律回首頁（避免 open redirect）。
 * 不自己猜瀏覽器怎麼解析（URL 解析器會吃掉 tab、換行，並把 `\\` 當成 `/`），
 * 而是實際對一個假 origin 解析，origin 變了就拒絕；回傳解析後的 pathname + search + hash。
 */
export function safeNextPath(value: string | null): string {
  if (!value || !value.startsWith("/")) return "/";
  let resolved: URL;
  try {
    resolved = new URL(value, SENTINEL_ORIGIN);
  } catch {
    return "/";
  }
  if (resolved.origin !== SENTINEL_ORIGIN) return "/";
  return resolved.pathname + resolved.search + resolved.hash;
}

/** 登入頁的路徑；版面與導向共用這一個常數。 */
export const LOGIN_PATH = "/login";

/** 未登入者要去登入頁的網址，登入後回到 `url` 這一頁。 */
export function loginUrl(url: URL): string {
  return `${LOGIN_PATH}?next=${encodeURIComponent(url.pathname + url.search)}`;
}

/** 管理後台（`/admin` 與其底下）由 Cloudflare Access 保護，與顧客登入無關。 */
export function isAdminPath(pathname: string): boolean {
  return pathname === "/admin" || pathname.startsWith("/admin/");
}

/**
 * Better Auth 的 session cookie（https 下帶 `__Secure-` 前綴）。沒有它就不必問 App Worker。
 * cookie 名稱是 `<前綴>.session_token`，前綴是 App `createAuth` 的 `advanced.cookiePrefix`，
 * 兩邊共用 `src/auth/paths.ts` 的 `AUTH_COOKIE_PREFIX`；Better Auth 改了 cookie 命名規則時要一起檢查這裡。
 */
const SESSION_COOKIE = new RegExp(`^(__Secure-)?${AUTH_COOKIE_PREFIX}\\.session_token=`);

export function hasSessionCookie(cookieHeader: string): boolean {
  return cookieHeader.split(";").some((part) => SESSION_COOKIE.test(part.trim()));
}
