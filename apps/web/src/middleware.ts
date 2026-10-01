import { env } from "cloudflare:workers";
import { defineMiddleware } from "astro:middleware";
import { forwardedAuthHeaders, hasSessionCookie, isAdminPath, isAuthPath } from "./auth/customer";

export const onRequest = defineMiddleware(async (context, next) => {
  // Public immutable image reads never query or refresh customer sessions.
  if (context.url.pathname.startsWith("/images/")) return next();

  // 登入、回呼、登出都由 App Worker 的 Better Auth 處理；redirect 要原樣（302 + Location）回給瀏覽器，
  // 不能在 Worker 內被追隨，所以明確設 manual。標頭經 forwardedAuthHeaders 過濾（App 的限流只認 cf-connecting-ip）
  if (isAuthPath(context.url.pathname)) {
    const headers = forwardedAuthHeaders(context.request.headers);
    return env.APP.fetch(new Request(context.request, { redirect: "manual", headers }));
  }

  // 沒有 session cookie 就不打 RPC。session 是否有效完全由 App 判斷，Web 只把結果放進 locals；
  // 查詢失敗一律當作未登入，公開頁面不能因為登入功能出問題而 500
  context.locals.customer = null;
  let setCookies: string[] = [];
  const cookie = context.request.headers.get("cookie");
  // 後台由 Access 保護、不顯示顧客狀態，所以 /admin 不查 session
  if (cookie && hasSessionCookie(cookie) && !isAdminPath(context.url.pathname)) {
    try {
      const lookup = await env.APP.getCustomerSession(cookie);
      context.locals.customer = lookup.customer;
      setCookies = lookup.setCookies;
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "customer_session_lookup_failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  const response = await next();
  if (setCookies.length === 0) return response;
  // 回應自己已經處理 session cookie（例如刪除帳號後清掉它）就不能再把延長的舊 cookie 附上去，否則會把它寫回瀏覽器
  if (response.headers.getSetCookie().some(hasSessionCookie)) return response;
  // session 被延長時 Better Auth 會重發 cookie；RPC 沒有 Response 可帶，所以在這裡附加，
  // 瀏覽器 cookie 的壽命才會跟 D1 裡的 session 一致。next() 回的 Response 的 headers 不保證可變，複製一份
  const withCookies = new Response(response.body, response);
  for (const setCookie of setCookies) withCookies.headers.append("set-cookie", setCookie);
  return withCookies;
});
