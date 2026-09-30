import { env } from "cloudflare:workers";

/** 每個測試開始前清空商品；只做測試隔離，斷言一律走 RPC。 */
export async function resetDb(): Promise<void> {
  await env.DB.exec("DELETE FROM products");
}
