import { sql, type SQL } from "drizzle-orm";
import { effectiveNow } from "../shared/high-water-mark";
import { hasDeliverableQuantity, isLatestEvent, undeliverableInBatchQuantity } from "../shipments/queries";

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

/** 批次實際送達的商品與數量一段文字（以 `shipments` 為外層列）：扣掉確認遺失與物流退回的數量，只列可送達的。 */
const deliveredItemsText = sql`(SELECT group_concat(line.product_name || CASE WHEN line.variant_label <> '' THEN '（' || line.variant_label || '）' ELSE '' END || ' × ' || (item.quantity - ${undeliverableInBatchQuantity(sql`item.order_line_id`, sql`shipments.id`)}), '、')
  FROM shipment_items item JOIN order_lines line ON line.id = item.order_line_id WHERE item.shipment_id = shipments.id AND item.quantity > ${undeliverableInBatchQuantity(sql`item.order_line_id`, sql`shipments.id`)})`;

/**
 * 送達通知：一個出貨批次一封，事件鍵 `shipment_delivered:<批次編號>`；只在該批已有實際送達時間、且還有可送達（未遺失、未被物流退回）的數量時寫（部分遺失或退回的批次照寄，只列可送達的數量；全數遺失或退回的批次不寄），信件記載寫信當下的送達時間（之後才到的較早送達回報會改 `delivered_at`，但不改寫已寄出的信）；
 * 多筆送達回報、重送都只會有一封（信遺失時同一事件重送會補回）。信件描述這一批的商品與實際送達時間（台灣時間）。
 */
export function insertDeliveredNotice(shipmentId: number): SQL {
  return sql`
    INSERT INTO mail_messages (customer_id, kind, subject, body, event_key, created_at)
    SELECT orders.customer_id, 'shipment_delivered', '訂單 #' || orders.id || ' 有一批商品已送達',
      '訂單 #' || orders.id || ' 有一批商品已送達：' || ${deliveredItemsText} || '。' ||
      '送達時間：' || strftime('%Y-%m-%d %H:%M', shipments.delivered_at / 1000, 'unixepoch', '+8 hours') || '（台灣時間）。' ||
      CASE WHEN EXISTS (SELECT 1 FROM shipment_loss_items WHERE loss_id IN (SELECT id FROM shipment_losses WHERE shipment_id = shipments.id))
        THEN '這一批另有商品經物流確認遺失，已另行通知退款事宜，上面只列實際送達的數量。' ELSE '' END ||
      CASE WHEN EXISTS (SELECT 1 FROM shipment_returns WHERE shipment_id = shipments.id)
        THEN '這一批另有商品被物流退回倉庫，已另行通知，上面只列實際送達的數量。' ELSE '' END ||
      '送達隔日起 7 天內可在訂單頁自助申請退貨。各批出貨進度請至訂單頁查看。',
      'shipment_delivered:' || shipments.id, ${effectiveNow}
    FROM shipments JOIN orders ON orders.id = shipments.order_id
    WHERE shipments.id = ${shipmentId} AND shipments.delivered_at IS NOT NULL AND ${hasDeliverableQuantity(sql`shipments.id`)}
    ON CONFLICT (event_key) DO NOTHING
  `;
}

/**
 * 配送異常通知：一次配送失敗回報一封，事件鍵 `shipment_delivery_failed:<批次編號>:<回報事件鍵>`。
 * 回報存在且是配送失敗、該批尚未送達也沒有確認遺失或物流退回、而且它是該批發生時間最新的回報才寫（已送達、已確認遺失或已物流退回後才到、或已被後續回報取代的失敗回報只留紀錄，不通知顧客；
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
    WHERE event.shipment_id = ${shipmentId} AND event.event_key = ${eventKey} AND event.kind = 'delivery_failed' AND shipments.delivery_status NOT IN ('delivered', 'lost', 'returned') AND ${isLatestEvent("event")}
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

/** 退貨申請的商品與數量一段文字（以 `return_requests` 為外層列，別名 `rr`）；`quantityColumn` 是申請數量或實際收到數量的欄位。 */
const returnItemsText = (quantityColumn: "quantity" | "received_quantity") => sql`(SELECT group_concat(line.product_name || CASE WHEN line.variant_label <> '' THEN '（' || line.variant_label || '）' ELSE '' END || ' × ' || item.${sql.raw(quantityColumn)}, '、')
  FROM return_request_items item JOIN order_lines line ON line.id = item.order_line_id WHERE item.request_id = rr.id AND item.${sql.raw(quantityColumn)} > 0)`;

/** 退貨核准通知：一案一封，事件鍵 `return:<申請編號>:approved`；只在該案已核准時寫，與核准同一個 batch。信件請顧客依客服指示寄回，收到並檢查後才退款。 */
export function insertReturnApprovedNotice(requestId: number): SQL {
  return sql`
    INSERT INTO mail_messages (customer_id, kind, subject, body, event_key, created_at)
    SELECT orders.customer_id, 'return_approved', '訂單 #' || orders.id || ' 的退貨申請已核准',
      '訂單 #' || orders.id || ' 的退貨申請已核准：' || ${returnItemsText("quantity")} || '。' ||
      '請依客服指示寄回商品（收回運費由商家負擔）；我們收到並檢查後，會依原實付單價退款並另行通知。' ||
      CASE WHEN rr.decision_note <> '' THEN '說明：' || rr.decision_note || '。' ELSE '' END,
      'return:' || rr.id || ':approved', ${effectiveNow}
    FROM return_requests rr JOIN orders ON orders.id = rr.order_id
    WHERE rr.id = ${requestId} AND rr.status = 'approved'
    ON CONFLICT (event_key) DO NOTHING
  `;
}

/** 退貨拒絕通知：一案一封，事件鍵 `return:<申請編號>:rejected`；只在該案已拒絕時寫，帶審核備註。 */
export function insertReturnRejectedNotice(requestId: number): SQL {
  return sql`
    INSERT INTO mail_messages (customer_id, kind, subject, body, event_key, created_at)
    SELECT orders.customer_id, 'return_rejected', '訂單 #' || orders.id || ' 的退貨申請未獲核准',
      '訂單 #' || orders.id || ' 的退貨申請未獲核准：' || ${returnItemsText("quantity")} || '。' ||
      CASE WHEN rr.decision_note <> '' THEN '說明：' || rr.decision_note || '。' ELSE '' END ||
      '如有疑問請聯絡客服。',
      'return:' || rr.id || ':rejected', ${effectiveNow}
    FROM return_requests rr JOIN orders ON orders.id = rr.order_id
    WHERE rr.id = ${requestId} AND rr.status = 'rejected'
    ON CONFLICT (event_key) DO NOTHING
  `;
}

/**
 * 退貨檢查完成通知：一案一封，事件鍵 `return:<申請編號>:completed`；只在該案已完成時寫，與檢查記錄同一個 batch。
 * 信件說明實際收到的商品與應退金額（商品款加符合條件的原運費）；通知依退款是否已登記分文案，退款完成另有退款成功通知。
 */
export function insertReturnCompletedNotice(requestId: number): SQL {
  return sql`
    INSERT INTO mail_messages (customer_id, kind, subject, body, event_key, created_at)
    SELECT orders.customer_id, 'return_completed', '訂單 #' || orders.id || ' 的退貨已收到並檢查完成',
      '訂單 #' || orders.id || ' 的退貨已收到並檢查完成：' || ${returnItemsText("received_quantity")} || '。' ||
      '應退款 NT$' || (rr.goods_twd + rr.standard_shipping_twd + rr.large_shipping_twd) || '（商品款 NT$' || rr.goods_twd || '、運費 NT$' || (rr.standard_shipping_twd + rr.large_shipping_twd) || '），' ||
      CASE WHEN EXISTS (SELECT 1 FROM refunds WHERE refunds.return_request_id = rr.id)
        THEN '退款完成會另行通知；各筆退款的進度請至訂單頁查看。'
        ELSE '這筆退款目前還不能自動辦理，客服會與你聯繫處理。' END,
      'return:' || rr.id || ':completed', ${effectiveNow}
    FROM return_requests rr JOIN orders ON orders.id = rr.order_id
    WHERE rr.id = ${requestId} AND rr.status = 'completed'
    ON CONFLICT (event_key) DO NOTHING
  `;
}

/** 確認遺失的商品與數量一段文字（以 `shipment_losses` 為外層列，別名 `sl`）。 */
const lossItemsText = sql`(SELECT group_concat(line.product_name || CASE WHEN line.variant_label <> '' THEN '（' || line.variant_label || '）' ELSE '' END || ' × ' || item.quantity, '、')
  FROM shipment_loss_items item JOIN order_lines line ON line.id = item.order_line_id WHERE item.loss_id = sl.id)`;

/**
 * 確認遺失通知：一案一封，事件鍵 `shipment_loss:<遺失編號>:confirmed`，與確認同一個 batch 寫入。
 * 信件說明遺失的商品與數量、不會補寄（需要再購買請重新下單）與應退金額（商品款加符合條件的原運費）；
 * 通知依退款是否已登記分文案，退款完成另有退款成功通知。
 */
export function insertLossConfirmedNotice(lossId: number | SQL): SQL {
  return sql`
    INSERT INTO mail_messages (customer_id, kind, subject, body, event_key, created_at)
    SELECT orders.customer_id, 'shipment_loss_confirmed', '訂單 #' || orders.id || ' 有商品確認在運送中遺失',
      '訂單 #' || orders.id || ' 有商品經物流確認在運送中遺失：' || ${lossItemsText} || '。' ||
      '這些商品不會補寄，如需再購買請重新下單。' ||
      CASE WHEN sl.goods_twd + sl.standard_shipping_twd + sl.large_shipping_twd = 0 THEN '這些商品沒有需要退款的金額。'
        ELSE '應退款 NT$' || (sl.goods_twd + sl.standard_shipping_twd + sl.large_shipping_twd) || '（商品款 NT$' || sl.goods_twd || '、運費 NT$' || (sl.standard_shipping_twd + sl.large_shipping_twd) || '），' ||
          CASE WHEN EXISTS (SELECT 1 FROM refunds WHERE refunds.shipment_loss_id = sl.id)
            THEN '退款完成會另行通知；各筆退款的進度請至訂單頁查看。'
            ELSE '這筆退款目前還不能自動辦理，客服會與你聯繫處理。' END END,
      'shipment_loss:' || sl.id || ':confirmed', ${effectiveNow}
    FROM shipment_losses sl JOIN orders ON orders.id = sl.order_id
    WHERE sl.id = ${lossId}
    ON CONFLICT (event_key) DO NOTHING
  `;
}

/** 物流退回的商品與數量一段文字（以 `shipment_returns` 為外層列，別名 `sr`）：退回的數量，加上尋回的遺失品。 */
const shipmentReturnItemsText = sql`(SELECT group_concat(line.product_name || CASE WHEN line.variant_label <> '' THEN '（' || line.variant_label || '）' ELSE '' END || ' × ' || (item.quantity + item.found_lost_quantity), '、')
  FROM shipment_return_items item JOIN order_lines line ON line.id = item.order_line_id WHERE item.return_id = sr.id)`;

/**
 * 物流退回登記通知：一案一封，事件鍵 `shipment_return:<物流退回編號>:declared`，與登記同一個 batch 寫入。
 * 信件說明哪些商品被物流送回倉庫、收到並檢查後才會退款，也不會從這張訂單補寄（需要再購買請重新下單）。
 */
export function insertShipmentReturnDeclaredNotice(returnId: number | SQL): SQL {
  return sql`
    INSERT INTO mail_messages (customer_id, kind, subject, body, event_key, created_at)
    SELECT orders.customer_id, 'shipment_return_declared', '訂單 #' || orders.id || ' 有商品被物流退回倉庫',
      '訂單 #' || orders.id || ' 有商品因配送異常被物流退回倉庫：' || ${shipmentReturnItemsText} || '。' ||
      '商品實際收到並檢查後會退款，退款金額與進度會另行通知；這些商品不會從這張訂單補寄，如需再購買請重新下單。',
      'shipment_return:' || sr.id || ':declared', ${effectiveNow}
    FROM shipment_returns sr JOIN orders ON orders.id = sr.order_id
    WHERE sr.id = ${returnId}
    ON CONFLICT (event_key) DO NOTHING
  `;
}

/**
 * 物流退回入倉檢查完成通知：一案一封，事件鍵 `shipment_return:<物流退回編號>:completed`；只在該案已完成時寫，與檢查記錄同一個 batch。
 * 信件說明實際收到的商品與應退金額（商品款加符合條件的原運費）；通知依退款是否已登記分文案（沒有需要退款的金額、已登記、還不能自動辦理），退款完成另有退款成功通知。
 */
export function insertShipmentReturnCompletedNotice(returnId: number | SQL): SQL {
  return sql`
    INSERT INTO mail_messages (customer_id, kind, subject, body, event_key, created_at)
    SELECT orders.customer_id, 'shipment_return_completed', '訂單 #' || orders.id || ' 被物流退回的商品已收到並檢查完成',
      '訂單 #' || orders.id || ' 被物流退回的商品已收到並檢查完成：' || ${shipmentReturnItemsText} || '。' ||
      CASE WHEN sr.goods_twd + sr.standard_shipping_twd + sr.large_shipping_twd = 0 THEN '這些商品沒有需要退款的金額。'
        ELSE '應退款 NT$' || (sr.goods_twd + sr.standard_shipping_twd + sr.large_shipping_twd) || '（商品款 NT$' || sr.goods_twd || '、運費 NT$' || (sr.standard_shipping_twd + sr.large_shipping_twd) || '），' ||
          CASE WHEN EXISTS (SELECT 1 FROM refunds WHERE refunds.shipment_return_id = sr.id)
            THEN '退款完成會另行通知；各筆退款的進度請至訂單頁查看。'
            ELSE '這筆退款目前還不能自動辦理，客服會與你聯繫處理。' END END,
      'shipment_return:' || sr.id || ':completed', ${effectiveNow}
    FROM shipment_returns sr JOIN orders ON orders.id = sr.order_id
    WHERE sr.id = ${returnId} AND sr.status = 'completed'
    ON CONFLICT (event_key) DO NOTHING
  `;
}
