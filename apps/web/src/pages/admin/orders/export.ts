import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { readAccessJwt } from "../../../admin/access-jwt";
import { readOrderSearch, searchToInput } from "../../../admin/order-search";
import { exportOrdersResponse } from "../../../admin/orders-export";

export const prerender = false;

// 授權完全由 App Worker 驗 JWT 決定；條件與列表頁相同（同一份網址參數、同一個 RPC 條件）
export const GET: APIRoute = ({ request, url }) => {
  const jwt = readAccessJwt(request, env, import.meta.env.DEV);
  const search = readOrderSearch(url.searchParams);
  const today = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  return exportOrdersResponse((beforeId) => env.APP.exportOrdersForAdmin(jwt, searchToInput(search, beforeId)), `orders-${today}.csv`);
};
