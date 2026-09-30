import { env } from "cloudflare:workers";

/** 每個測試開始前清空訂單、商品與登入資料（外鍵順序：訂單明細、訂單先於商品與顧客；session、account 隨 user 級聯刪除）；只做測試隔離，斷言一律走 RPC 或 HTTP。 */
export async function resetDb(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM order_lines"),
    env.DB.prepare("DELETE FROM orders"),
    env.DB.prepare("DELETE FROM products"),
    env.DB.prepare('DELETE FROM "user"'),
    env.DB.prepare("DELETE FROM verification"),
    env.DB.prepare("DELETE FROM rate_limit"),
    // 高水位只增不減；測試之間時間會倒退，所以要清空（Holdfast ADR 0011）
    env.DB.prepare("DELETE FROM clock"),
  ]);
}
