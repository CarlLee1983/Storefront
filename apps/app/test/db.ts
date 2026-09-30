import { env } from "cloudflare:workers";

/** 每個測試開始前清空商品與登入資料（session、account 隨 user 級聯刪除）；只做測試隔離，斷言一律走 RPC 或 HTTP。 */
export async function resetDb(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM products"),
    env.DB.prepare('DELETE FROM "user"'),
    env.DB.prepare("DELETE FROM verification"),
    env.DB.prepare("DELETE FROM rate_limit"),
  ]);
}
