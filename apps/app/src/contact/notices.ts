import { sql, type SQL } from "drizzle-orm";
import { effectiveNow } from "../shared/high-water-mark";

/**
 * 交易通知的信件本體（outbox）：和業務變化寫在同一個 batch，所以業務事實成立，信就一定存在，
 * 不會因為之後投遞階段出錯而遺失。事件鍵唯一，`ON CONFLICT DO NOTHING` 讓重送與重試不產生第二封。
 * 信件只描述事實，不依賴寄信時的狀態；實際投遞在交易外（見 `deliverNotice`）。
 */

/** 下單通知：一張訂單一封。`ownOrder` 選出這張訂單的條件；訂單沒有明細（被拒而清掉）時不寫。 */
export function insertOrderPlacedNotice(ownOrder: SQL): SQL {
  return sql`
    INSERT INTO mail_messages (customer_id, kind, subject, body, event_key, created_at)
    SELECT orders.customer_id, 'order_placed', '訂單 #' || orders.id || ' 已成立',
      '你的訂單 #' || orders.id || ' 已成立，應付 NT$' || orders.total_twd || '。付款期限與付款狀態請至訂單頁查看。',
      'order_placed:' || orders.id, ${effectiveNow}
    FROM orders
    WHERE ${ownOrder} AND EXISTS (SELECT 1 FROM order_lines line WHERE line.order_id = orders.id)
    ON CONFLICT (event_key) DO NOTHING
  `;
}

/**
 * 付款結果通知：一筆付款一封，付款已有結果（成功、失敗，或之後轉為退款）才寫。
 * 種類看這筆付款是不是讓訂單轉為已付款的那一筆：失敗 → `payment_failed`；是 → `payment_succeeded`；
 * 成功卻沒有讓訂單成立（遲到、已取消、重複付款）→ `payment_unsettled`。
 */
export function insertPaymentResultNotice(gatewayPaymentId: string): SQL {
  return sql`
    INSERT INTO mail_messages (customer_id, kind, subject, body, event_key, created_at)
    SELECT t.customer_id, t.kind,
      CASE t.kind
        WHEN 'payment_failed' THEN '訂單 #' || t.order_id || ' 付款失敗'
        WHEN 'payment_succeeded' THEN '訂單 #' || t.order_id || ' 付款成功'
        ELSE '訂單 #' || t.order_id || ' 的付款未能生效'
      END,
      CASE t.kind
        WHEN 'payment_failed' THEN '訂單 #' || t.order_id || ' 這次 NT$' || t.amount_twd || ' 的付款沒有成功。訂單若仍在付款期限內，可以重新付款。'
        WHEN 'payment_succeeded' THEN '訂單 #' || t.order_id || ' 已收到 NT$' || t.amount_twd || ' 的付款，我們會盡快安排出貨。'
        ELSE '訂單 #' || t.order_id || ' 的 NT$' || t.amount_twd || ' 付款到達時訂單已無法成立（例如已取消或庫存不足），這筆款項不會用於這張訂單。後續退款由我們處理，如需協助客服會與你聯繫。'
      END,
      'payment:' || t.payment_id, ${effectiveNow}
    FROM (
      SELECT orders.customer_id AS customer_id, payments.id AS payment_id, payments.order_id AS order_id, payments.amount_twd AS amount_twd,
        CASE WHEN payments.status = 'failed' THEN 'payment_failed'
             WHEN orders.paid_by_payment_id = payments.id THEN 'payment_succeeded'
             ELSE 'payment_unsettled' END AS kind
      FROM payments JOIN orders ON orders.id = payments.order_id
      WHERE payments.gateway_payment_id = ${gatewayPaymentId}
        AND payments.status IN ('succeeded', 'failed', 'refunded', 'refund_failed')
    ) t
    WHERE true
    ON CONFLICT (event_key) DO NOTHING
  `;
}

/**
 * 出貨通知：一個出貨批次一封，事件鍵 `shipment:<批次編號>`，同一批的重送（同一冪等鍵）只會有一封。
 * 信件描述這一批的商品數量、物流單號與議定時段（台灣時間）；批次不存在（被擋下）時不寫。
 */
export function insertShipmentNotice(orderId: number, dispatchKey: string): SQL {
  return sql`
    INSERT INTO mail_messages (customer_id, kind, subject, body, event_key, created_at)
    SELECT orders.customer_id, 'shipment_dispatched', '訂單 #' || orders.id || ' 有一批商品已出貨',
      '訂單 #' || orders.id || ' 有一批商品已交運：' ||
      (SELECT group_concat(line.product_name || CASE WHEN line.variant_label <> '' THEN '（' || line.variant_label || '）' ELSE '' END || ' × ' || item.quantity, '、')
         FROM shipment_items item JOIN order_lines line ON line.id = item.order_line_id WHERE item.shipment_id = shipments.id) || '。' ||
      CASE WHEN shipments.tracking_number IS NOT NULL THEN '物流單號：' || shipments.tracking_number || '。' ELSE '' END ||
      CASE WHEN shipments.appointment_start IS NOT NULL
        THEN '議定配送時段：' || strftime('%Y-%m-%d %H:%M', shipments.appointment_start / 1000, 'unixepoch', '+8 hours') || ' 至 ' || strftime('%Y-%m-%d %H:%M', shipments.appointment_end / 1000, 'unixepoch', '+8 hours') || '（台灣時間）。'
        ELSE '' END ||
      '各批出貨進度請至訂單頁查看。',
      'shipment:' || shipments.id, ${effectiveNow}
    FROM shipments JOIN orders ON orders.id = shipments.order_id
    WHERE shipments.order_id = ${orderId} AND shipments.dispatch_key = ${dispatchKey}
    ON CONFLICT (event_key) DO NOTHING
  `;
}
