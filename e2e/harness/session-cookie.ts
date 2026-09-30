import { createHmac } from "node:crypto";
import { AUTH_COOKIE_PREFIX } from "@storefront/app/auth-paths";
import { AUTH_SECRET, BASE_URL, SESSION } from "./constants";

/**
 * Better Auth 的 session cookie（ADR 0013）：值是 `encodeURIComponent("<session.token>.<base64 HMAC-SHA256>")`，
 * 與 better-call 的 `signCookieValue` 相同。base URL 是 http，所以 cookie 名稱沒有 `__Secure-` 前綴。
 */
export function memberSessionCookie(session: { token: string } = SESSION) {
  const signature = createHmac("sha256", AUTH_SECRET).update(session.token).digest("base64");
  return {
    name: `${AUTH_COOKIE_PREFIX}.session_token`,
    value: encodeURIComponent(`${session.token}.${signature}`),
    url: BASE_URL,
    httpOnly: true,
    sameSite: "Lax" as const,
  };
}
