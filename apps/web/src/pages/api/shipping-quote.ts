import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";

export const prerender = false;

// 結帳頁試算運費：購物車只存在瀏覽器，所以由頁面帶變體編號來問現行費率與各變體的配送類型。
// 公開資料、不需要 session；真正收取的運費仍由下單時重算並與顧客確認的金額比對
export const GET: APIRoute = async ({ url }) => {
  const variantIds = (url.searchParams.get("variants") ?? "").split(",").filter((id) => id !== "").map(Number);
  const result = await env.APP.getShippingQuote({ variantIds });
  return Response.json(result.ok ? result.data : { error: result.reason }, {
    status: result.ok ? 200 : 400,
    headers: { "cache-control": "no-store" },
  });
};
