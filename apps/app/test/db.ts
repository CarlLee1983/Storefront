import { env } from "cloudflare:workers";

/** 每個測試開始前清空訂單、商品與登入資料（外鍵順序：付款、訂單明細、訂單先於商品與顧客，商品先於分類，分類圖片先於分類；session、account 隨 user 級聯刪除）；只做測試隔離，斷言一律走 RPC 或 HTTP。 */
export async function resetDb(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM payment_events"),
    env.DB.prepare("DELETE FROM payments"),
    env.DB.prepare("DELETE FROM order_lines"),
    env.DB.prepare("DELETE FROM orders"),
    env.DB.prepare("DELETE FROM product_images"),
    env.DB.prepare("DELETE FROM product_image_deletions"),
    env.DB.prepare("DELETE FROM products"),
    env.DB.prepare("DELETE FROM category_images"),
    env.DB.prepare("DELETE FROM categories"),
    env.DB.prepare('DELETE FROM "user"'),
    env.DB.prepare("DELETE FROM verification"),
    env.DB.prepare("DELETE FROM rate_limit"),
    // 高水位只增不減；測試之間時間會倒退，所以要清空（Holdfast ADR 0011）
    env.DB.prepare("DELETE FROM clock"),
  ]);
}

/**
 * 直接把訂單設成指定狀態：逾期與取消由 #9 的 Cron 與取消 RPC 負責，這裡只是為了在付款的測試中安排前置狀態。
 * 斷言仍然一律走 RPC。
 */
export async function forceOrderStatus(orderId: number, status: string): Promise<void> {
  await env.DB.prepare("UPDATE orders SET status = ? WHERE id = ?").bind(status, orderId).run();
}

/** 直接寫入一筆付款（測試安排前置狀態用），回傳它的閘道付款 ID。 */
export async function seedPayment(orderId: number, status: string, gatewayPaymentId = `seed_${orderId}_${status}`): Promise<string> {
  await env.DB
    .prepare("INSERT INTO payments (order_id, gateway_payment_id, amount_twd, status, created_at, expires_at) VALUES (?, ?, 1, ?, 0, 9007199254740991)")
    .bind(orderId, gatewayPaymentId, status)
    .run();
  return gatewayPaymentId;
}

/** 直接改一筆付款的狀態（測試安排前置狀態用，例如「舊的成功付款、沒有退款紀錄」）。 */
export async function forcePaymentStatus(gatewayPaymentId: string, status: string): Promise<void> {
  await env.DB.prepare("UPDATE payments SET status = ? WHERE gateway_payment_id = ?").bind(status, gatewayPaymentId).run();
}
