import { sql, type SQL } from "drizzle-orm";
import { effectiveNow } from "../shared/high-water-mark";
import { isLatestEvent } from "../shipments/queries";

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
 * 付款結果通知：一筆付款一封，付款已有結果（成功、失敗）才寫。
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
        AND payments.status IN ('succeeded', 'failed')
    ) t
    WHERE true
    ON CONFLICT (event_key) DO NOTHING
  `;
}

/**
 * 退款成功通知：一筆退款一封，事件鍵 `refund:<退款編號>`；只在該筆退款已成功時才寫，與退款轉為成功同一個 batch（見 `payments/refunds.ts` 的 `recordRefundAttempt`）。
 * 重試與重複回呼都只會有一封；退款失敗或結果不明時不寄（顧客在訂單頁看得到進度）。
 */
export function insertRefundNotice(refundId: number): SQL {
  return sql`
    INSERT INTO mail_messages (customer_id, kind, subject, body, event_key, created_at)
    SELECT orders.customer_id, 'refund_succeeded', '訂單 #' || orders.id || ' 已退款 NT$' || refunds.amount_twd,
      '訂單 #' || orders.id || ' 有一筆 NT$' || refunds.amount_twd || ' 的款項已退回原付款方式，實際入帳時間依你的付款機構而定。各筆退款的進度請至訂單頁查看。',
      'refund:' || refunds.id, ${effectiveNow}
    FROM refunds JOIN orders ON orders.id = refunds.order_id
    WHERE refunds.id = ${refundId} AND refunds.status = 'succeeded'
    ON CONFLICT (event_key) DO NOTHING
  `;
}

/** 批次的商品與數量一段文字（以 `shipments` 為外層列）。 */
const shipmentItemsText = sql`(SELECT group_concat(line.product_name || CASE WHEN line.variant_label <> '' THEN '（' || line.variant_label || '）' ELSE '' END || ' × ' || item.quantity, '、')
  FROM shipment_items item JOIN order_lines line ON line.id = item.order_line_id WHERE item.shipment_id = shipments.id)`;

/**
 * 出貨通知：一個出貨批次一封，事件鍵 `shipment:<批次編號>`，同一批的重送（同一冪等鍵）只會有一封。
 * 信件描述這一批的商品數量、物流單號與議定時段（台灣時間）；批次不存在（被擋下）時不寫。
 */
export function insertShipmentNotice(orderId: number, dispatchKey: string): SQL {
  return sql`
    INSERT INTO mail_messages (customer_id, kind, subject, body, event_key, created_at)
    SELECT orders.customer_id, 'shipment_dispatched', '訂單 #' || orders.id || ' 有一批商品已出貨',
      '訂單 #' || orders.id || ' 有一批商品已交運：' ||
      ${shipmentItemsText} || '。' ||
      CASE WHEN shipments.tracking_number IS NOT NULL THEN '物流單號：' || shipments.tracking_number || '。' ELSE '' END ||
      CASE WHEN shipments.appointment_start IS NOT NULL
        THEN '議定配送時段：' || strftime('%Y-%m-%d %H:%M', shipments.appointment_start / 1000, 'unixepoch', '+8 hours') || ' 至 ' || strftime('%Y-%m-%d %H:%M', shipments.appointment_end / 1000, 'unixepoch', '+8 hours') || '（台灣時間）。'
        ELSE '' END ||
      '各批出貨進度請至訂單頁查看。',
      'shipment:' || shipments.id, ${effectiveNow}
    FROM shipments JOIN orders ON orders.id = shipments.order_id
    WHERE shipments.order_id = ${orderId} AND shipments.dispatch_key = ${dispatchKey} AND shipments.request_hash IS NOT NULL
    ON CONFLICT (event_key) DO NOTHING
  `;
}

/**
 * 送達通知：一個出貨批次一封，事件鍵 `shipment_delivered:<批次編號>`；只在該批目前已送達時寫，信件記載寫信當下的送達時間（之後才到的較早送達回報會改 `delivered_at`，但不改寫已寄出的信）；
 * 多筆送達回報、重送都只會有一封（信遺失時同一事件重送會補回）。信件描述這一批的商品與實際送達時間（台灣時間）。
 */
export function insertDeliveredNotice(shipmentId: number): SQL {
  return sql`
    INSERT INTO mail_messages (customer_id, kind, subject, body, event_key, created_at)
    SELECT orders.customer_id, 'shipment_delivered', '訂單 #' || orders.id || ' 有一批商品已送達',
      '訂單 #' || orders.id || ' 有一批商品已送達：' || ${shipmentItemsText} || '。' ||
      '送達時間：' || strftime('%Y-%m-%d %H:%M', shipments.delivered_at / 1000, 'unixepoch', '+8 hours') || '（台灣時間）。' ||
      '各批出貨進度請至訂單頁查看。',
      'shipment_delivered:' || shipments.id, ${effectiveNow}
    FROM shipments JOIN orders ON orders.id = shipments.order_id
    WHERE shipments.id = ${shipmentId} AND shipments.delivery_status = 'delivered'
    ON CONFLICT (event_key) DO NOTHING
  `;
}

/**
 * 配送異常通知：一次配送失敗回報一封，事件鍵 `shipment_delivery_failed:<批次編號>:<回報事件鍵>`。
 * 回報存在且是配送失敗、該批尚未送達、而且它是該批發生時間最新的回報才寫（已送達後才到、或已被後續回報取代的失敗回報只留紀錄，不通知顧客；
 * 管理端的 `noticeExpected` 用同一個條件，所以「不寄」不會被當成通知缺漏）。
 * 信件說明物流仍持有原貨、會再次配送，顧客不需要重新下單。
 */
export function insertDeliveryFailedNotice(shipmentId: number, eventKey: string): SQL {
  return sql`
    INSERT INTO mail_messages (customer_id, kind, subject, body, event_key, created_at)
    SELECT orders.customer_id, 'shipment_delivery_failed', '訂單 #' || orders.id || ' 有一批商品配送未成功',
      '訂單 #' || orders.id || ' 有一批商品這次配送未成功：' || ${shipmentItemsText} || '。' ||
      '物流仍持有這批商品，會再次安排配送，你不需要重新下單；各批出貨進度請至訂單頁查看。',
      'shipment_delivery_failed:' || shipments.id || ':' || event.event_key, ${effectiveNow}
    FROM shipment_events event JOIN shipments ON shipments.id = event.shipment_id JOIN orders ON orders.id = shipments.order_id
    WHERE event.shipment_id = ${shipmentId} AND event.event_key = ${eventKey} AND event.kind = 'delivery_failed' AND shipments.delivery_status <> 'delivered' AND ${isLatestEvent("event")}
    ON CONFLICT (event_key) DO NOTHING
  `;
}

/** 取消申請的商品與數量一段文字（以 `cancellation_requests` 為外層列，別名 `cr`）。 */
const cancellationItemsText = sql`(SELECT group_concat(line.product_name || CASE WHEN line.variant_label <> '' THEN '（' || line.variant_label || '）' ELSE '' END || ' × ' || item.quantity, '、')
  FROM cancellation_request_items item JOIN order_lines line ON line.id = item.order_line_id WHERE item.request_id = cr.id)`;

/**
 * 取消核准通知：一案一封，事件鍵 `cancellation:<申請編號>:approved`；只在該案已核准時寫，與核准同一個 batch。
 * 信件說明取消的商品與數量、不再出貨，以及依原實付單價應退的金額（商品款加符合條件的原運費）；退款另有各筆進度與成功通知，退款失敗不影響取消結果。
 */
export function insertCancellationApprovedNotice(requestId: number): SQL {
  return sql`
    INSERT INTO mail_messages (customer_id, kind, subject, body, event_key, created_at)
    SELECT orders.customer_id, 'cancellation_approved', '訂單 #' || orders.id || ' 的取消申請已核准',
      '訂單 #' || orders.id || ' 的取消申請已核准：' || ${cancellationItemsText} || '。這些商品不會再出貨，保留已釋放。' ||
      '應退款 NT$' || (cr.goods_twd + cr.standard_shipping_twd + cr.large_shipping_twd) || '（商品款 NT$' || cr.goods_twd || '、運費 NT$' || (cr.standard_shipping_twd + cr.large_shipping_twd) || '），' ||
      CASE WHEN EXISTS (SELECT 1 FROM refunds WHERE refunds.cancellation_request_id = cr.id)
        THEN '退款完成會另行通知；各筆退款的進度請至訂單頁查看。'
        ELSE '這筆退款目前還不能自動辦理，客服會與你聯繫處理。' END,
      'cancellation:' || cr.id || ':approved', ${effectiveNow}
    FROM cancellation_requests cr JOIN orders ON orders.id = cr.order_id
    WHERE cr.id = ${requestId} AND cr.status = 'approved'
    ON CONFLICT (event_key) DO NOTHING
  `;
}

/** 取消拒絕通知：一案一封，事件鍵 `cancellation:<申請編號>:rejected`；只在該案已拒絕時寫。信件說明這些商品恢復正常出貨，並帶審核備註。 */
export function insertCancellationRejectedNotice(requestId: number): SQL {
  return sql`
    INSERT INTO mail_messages (customer_id, kind, subject, body, event_key, created_at)
    SELECT orders.customer_id, 'cancellation_rejected', '訂單 #' || orders.id || ' 的取消申請未獲核准',
      '訂單 #' || orders.id || ' 的取消申請未獲核准：' || ${cancellationItemsText} || '。這些商品會照常安排出貨。' ||
      CASE WHEN cr.decision_note <> '' THEN '說明：' || cr.decision_note || '。' ELSE '' END ||
      '如有疑問請聯絡客服；已出貨的商品可依退貨流程處理。',
      'cancellation:' || cr.id || ':rejected', ${effectiveNow}
    FROM cancellation_requests cr JOIN orders ON orders.id = cr.order_id
    WHERE cr.id = ${requestId} AND cr.status = 'rejected'
    ON CONFLICT (event_key) DO NOTHING
  `;
}
