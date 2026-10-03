import { env } from "cloudflare:workers";
import migration0020 from "../migrations/0020_stock_ledger.sql?raw";
import migration0032 from "../migrations/0032_order_search_notes.sql?raw";

/** 每個測試開始前清空訂單、商品與登入資料（外鍵順序：庫存流水、客服備註、待折讓義務、發票嘗試與發票（先於退款與付款）、退款嘗試與退款、物流退回明細與物流退回、確認遺失明細與確認遺失、出貨批次的物流回報事件、明細與批次、投遞紀錄、信件、驗證請求、退款嘗試與退款、退貨申請的批次對應與明細與退貨申請、取消申請明細與取消申請、付款補查待辦與付款、訂單明細、訂單先於商品變體與顧客，變體先於商品，商品先於分類，分類圖片先於分類；session、account 隨 user 級聯刪除）；只做測試隔離，斷言一律走 RPC 或 HTTP。 */
export async function resetDb(): Promise<void> {
  // 庫存流水有禁止刪改的 trigger（0020）：測試清理時暫時拿掉，清完用遷移裡同一份定義還原
  const triggers = migration0020.split("--> statement-breakpoint").filter((statement) => statement.includes("CREATE TRIGGER"));
  // 客服備註同理（0032）
  const noteTriggers = migration0032.split("--> statement-breakpoint").filter((statement) => statement.includes("CREATE TRIGGER"));
  await env.DB.batch([
    env.DB.prepare("DROP TRIGGER IF EXISTS stock_movements_no_delete"),
    env.DB.prepare("DROP TRIGGER IF EXISTS stock_movements_no_update"),
    env.DB.prepare("DELETE FROM stock_movements"),
    ...triggers.map((statement) => env.DB.prepare(statement.replace(/^[\s\S]*?(CREATE TRIGGER)/, "$1").trim())),
    env.DB.prepare("DROP TRIGGER IF EXISTS order_notes_no_delete"),
    env.DB.prepare("DROP TRIGGER IF EXISTS order_notes_no_update"),
    env.DB.prepare("DROP TRIGGER IF EXISTS order_notes_no_replace"),
    env.DB.prepare("DROP TRIGGER IF EXISTS stock_movements_no_replace"),
    env.DB.prepare("DELETE FROM order_notes"),
    ...noteTriggers.map((statement) => env.DB.prepare(statement.replace(/^[\s\S]*?(CREATE TRIGGER)/, "$1").trim())),
    env.DB.prepare("DELETE FROM allowance_attempts"),
    env.DB.prepare("DELETE FROM allowance_obligations"),
    env.DB.prepare("DELETE FROM invoice_attempts"),
    env.DB.prepare("DELETE FROM invoices"),
    env.DB.prepare("DELETE FROM refund_attempts"),
    env.DB.prepare("DELETE FROM refunds"),
    env.DB.prepare("DELETE FROM return_request_batches"),
    env.DB.prepare("DELETE FROM shipment_return_items"),
    env.DB.prepare("DELETE FROM shipment_returns"),
    env.DB.prepare("DELETE FROM shipment_loss_items"),
    env.DB.prepare("DELETE FROM shipment_losses"),
    env.DB.prepare("DELETE FROM shipment_events"),
    env.DB.prepare("DELETE FROM shipment_items"),
    env.DB.prepare("DELETE FROM shipments"),
    env.DB.prepare("DELETE FROM mail_deliveries"),
    env.DB.prepare("DELETE FROM mail_messages"),
    env.DB.prepare("DELETE FROM mail_controls"),
    env.DB.prepare("DELETE FROM contact_verifications"),
    env.DB.prepare("DELETE FROM customer_addresses"),
    env.DB.prepare("DELETE FROM refund_attempts"),
    env.DB.prepare("DELETE FROM refunds"),
    env.DB.prepare("DELETE FROM return_request_items"),
    env.DB.prepare("DELETE FROM return_requests"),
    env.DB.prepare("DELETE FROM cancellation_request_items"),
    env.DB.prepare("DELETE FROM cancellation_requests"),
    env.DB.prepare("DELETE FROM payment_reconcile_issues"),
    env.DB.prepare("DELETE FROM payment_events"),
    env.DB.prepare("DELETE FROM payments"),
    env.DB.prepare("DELETE FROM order_lines"),
    env.DB.prepare("DELETE FROM orders"),
    env.DB.prepare("DELETE FROM product_images"),
    env.DB.prepare("DELETE FROM product_image_deletions"),
    env.DB.prepare("DELETE FROM product_variants"),
    env.DB.prepare("DELETE FROM products"),
    env.DB.prepare("DELETE FROM category_images"),
    env.DB.prepare("DELETE FROM categories"),
    env.DB.prepare('DELETE FROM "user"'),
    env.DB.prepare("DELETE FROM verification"),
    // 費率由遷移寫入、每類型恰一列：不清空，只還原（含被測試刪掉的列）成初始演練值（一般 100、大型 600）
    env.DB.prepare("INSERT OR REPLACE INTO shipping_rates (delivery_type, fee_twd) VALUES ('standard', 100), ('large', 600)"),
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

/** 直接改訂單的成立時間（UTC epoch 毫秒；測試日期區間用）。 */
export async function forceOrderCreatedAt(orderId: number, createdAt: number): Promise<void> {
  await env.DB.prepare("UPDATE orders SET created_at = ? WHERE id = ?").bind(createdAt, orderId).run();
}

/** 直接寫入一筆付款（測試安排前置狀態用），回傳它的閘道付款 ID。 */
export async function seedPayment(orderId: number, status: string, gatewayPaymentId = `seed_${orderId}_${status}`, amountTwd = 1): Promise<string> {
  await env.DB
    .prepare("INSERT INTO payments (order_id, gateway_payment_id, amount_twd, status, created_at, expires_at) VALUES (?, ?, ?, ?, 0, 9007199254740991)")
    .bind(orderId, gatewayPaymentId, amountTwd, status)
    .run();
  return gatewayPaymentId;
}

/** 直接改一筆付款的狀態（測試安排前置狀態用，例如「舊的成功付款、沒有退款紀錄」）。 */
export async function forcePaymentStatus(gatewayPaymentId: string, status: string): Promise<void> {
  await env.DB.prepare("UPDATE payments SET status = ? WHERE gateway_payment_id = ?").bind(status, gatewayPaymentId).run();
}
