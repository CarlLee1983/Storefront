import { sql, type SQL } from "drizzle-orm";

/**
 * 某筆訂單明細被物流退回占用的數量（已交運數量中不能再退貨、遺失的部分）：登記後占用登記的數量，收回後占用實際收到的數量（沒收到的釋出），
 * 檢查完成維持實際收到的數量（已退回、已退款，不能再退），未收到釋出。尋回的遺失數量（`found_lost_quantity`）不在這裡：它本來就是遺失的數量，沒有占用新的份額。
 * 退貨申請、確認遺失與新的物流退回都以它扣除可用數量，同一句條件寫入互斥。
 */
export function heldByShipmentReturnQuantity(orderLineId: SQL): SQL<number> {
  return sql<number>`COALESCE((SELECT SUM(CASE WHEN held_return.status = 'returning' THEN held.quantity ELSE COALESCE(held.received_quantity, 0) END) FROM shipment_return_items held JOIN shipment_returns held_return ON held_return.id = held.return_id WHERE held.order_line_id = ${orderLineId} AND held_return.status IN ('returning', 'received', 'completed')), 0)`;
}

/** 某批某筆明細被物流退回占用的數量（同 `heldByShipmentReturnQuantity`，限定在某一批）；批次層級的上限與送達通知都用它。 */
export function returnedInBatchQuantity(orderLineId: SQL, shipmentId: SQL): SQL<number> {
  return sql<number>`COALESCE((SELECT SUM(CASE WHEN batch_return.status = 'returning' THEN batch_item.quantity ELSE COALESCE(batch_item.received_quantity, 0) END) FROM shipment_return_items batch_item JOIN shipment_returns batch_return ON batch_return.id = batch_item.return_id WHERE batch_item.order_line_id = ${orderLineId} AND batch_return.shipment_id = ${shipmentId} AND batch_return.status IN ('returning', 'received', 'completed')), 0)`;
}

/**
 * 某批某筆明細已被尋回的遺失數量（先前確認遺失並退款，之後物流退回入倉）：登記後占用登記的數量，收回後以實際收到的為準；
 * 尋回數量加起來不得超過該批確認遺失的數量。遺失本身不因此取消（已退款，仍算遺失、不可再退貨）。
 */
export function foundLostInBatchQuantity(orderLineId: SQL, shipmentId: SQL): SQL<number> {
  return sql<number>`COALESCE((SELECT SUM(CASE WHEN found_return.status = 'returning' THEN found.found_lost_quantity ELSE COALESCE(found.received_found_lost_quantity, 0) END) FROM shipment_return_items found JOIN shipment_returns found_return ON found_return.id = found.return_id WHERE found.order_line_id = ${orderLineId} AND found_return.shipment_id = ${shipmentId} AND found_return.status IN ('returning', 'received', 'completed')), 0)`;
}

/** 某筆訂單明細已完成入倉檢查的物流退回數量（實際收到並檢查完成）；與核准取消、完成退貨、確認遺失合稱「退出履約」，見 `payments/exit-refund.ts`。 */
export function completedShipmentReturnedQuantity(orderLineId: SQL): SQL<number> {
  return sql<number>`COALESCE((SELECT SUM(returned.received_quantity) FROM shipment_return_items returned JOIN shipment_returns returned_case ON returned_case.id = returned.return_id WHERE returned.order_line_id = ${orderLineId} AND returned_case.status = 'completed'), 0)`;
}

/** 某筆訂單明細物流退回進行中的數量（登記、已收回待檢查），顧客與管理員畫面顯示用。 */
export function openShipmentReturnQuantity(orderLineId: SQL): SQL<number> {
  return sql<number>`COALESCE((SELECT SUM(CASE WHEN open_return.status = 'returning' THEN open_item.quantity ELSE COALESCE(open_item.received_quantity, 0) END) FROM shipment_return_items open_item JOIN shipment_returns open_return ON open_return.id = open_item.return_id WHERE open_item.order_line_id = ${orderLineId} AND open_return.status IN ('returning', 'received')), 0)`;
}

/** 某個變體物流退回已收回、尚未檢查的實體數量（含尋回的遺失品）：在不可售數量裡但還不能報廢，見 `returns/queries.ts` 的 `awaitingInspectionQuantity`。 */
export function awaitingShipmentReturnInspectionQuantity(variantId: SQL): SQL<number> {
  return sql<number>`COALESCE((SELECT SUM(awaiting_item.received_quantity + awaiting_item.received_found_lost_quantity) FROM shipment_return_items awaiting_item JOIN shipment_returns awaiting_return ON awaiting_return.id = awaiting_item.return_id JOIN order_lines awaiting_line ON awaiting_line.id = awaiting_item.order_line_id WHERE awaiting_line.variant_id = ${variantId} AND awaiting_return.status = 'received'), 0)`;
}
