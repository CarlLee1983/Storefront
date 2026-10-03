import { sql, type SQL } from "drizzle-orm";
import { approvedCancelledQuantity } from "../cancellations/queries";
import { completedReturnedQuantity } from "../returns/queries";
import { completedShipmentReturnedQuantity } from "../shipment-returns/quantities";
import { lostQuantity } from "../shipments/queries";
import type { DeliveryType } from "../shipping/types";

/**
 * 某筆訂單明細已「退出履約」的數量：核准取消的（停止履約）、完成收回檢查的退貨、確認遺失的（#119，不回倉也不補寄）加完成入倉檢查的物流退回（#120）。運費退款的判斷以它為準：
 * 同一配送類型每筆明細都全數退出，才符合「全退出」（待審、在途與待檢的數量尚未退出）。
 */
export function exitedQuantity(orderLineId: SQL): SQL<number> {
  return sql<number>`(${approvedCancelledQuantity(orderLineId)} + ${completedReturnedQuantity(orderLineId)} + ${lostQuantity(orderLineId)} + ${completedShipmentReturnedQuantity(orderLineId)})`;
}

/** 運費退款所屬的案件：被更新的那張表（取消申請或退貨申請），以及這一案在某筆明細上的數量。 */
export interface ExitCase {
  /** 被 UPDATE 的資料表名，也是 SQL 裡引用「本案」的名稱。 */
  table: "cancellation_requests" | "return_requests";
  /** 本案在 `typed`（訂單明細的別名）這筆明細上的退出數量：取消為申請數量，退貨為實際收回數量。 */
  quantityOn: (typedLineId: SQL) => SQL;
}

export const CANCELLATION_CASE: ExitCase = {
  table: "cancellation_requests",
  quantityOn: (typedLineId) => sql`COALESCE((SELECT this_item.quantity FROM cancellation_request_items this_item WHERE this_item.request_id = cancellation_requests.id AND this_item.order_line_id = ${typedLineId}), 0)`,
};

export const RETURN_CASE: ExitCase = {
  table: "return_requests",
  quantityOn: (typedLineId) => sql`COALESCE((SELECT this_item.received_quantity FROM return_request_items this_item WHERE this_item.request_id = return_requests.id AND this_item.order_line_id = ${typedLineId}), 0)`,
};

/**
 * 這一類配送的原運費要不要隨這案退（UPDATE 的 SET 運算式，被更新的那一案此時還不是終態，所以不在別案的統計裡、要另外加上本案數量）：
 * 該類有明細，且該類每筆明細都「已退出（核准取消 + 完成退貨）+ 本案 = 全部數量」，
 * 且訂單上沒有其他已核准的取消、已完成的退貨、確認遺失或完成入倉檢查的物流退回已經退過這一類運費（`requestColumn` 欄位 > 0）。
 * 取消與退貨混合使同類全數退出也符合；任何觸發順序下，同一類原運費最多退一次，部分不退；
 * 費率後來調整不影響，用的是訂單上的運費快照，舊單為零就退零。
 */
export function shippingRefundSql(exitCase: ExitCase, type: DeliveryType, feeColumn: string, requestColumn: string): SQL {
  const { table, quantityOn } = exitCase;
  const self = sql.raw(table);
  const fee = sql.raw(feeColumn);
  const refunded = sql.raw(requestColumn);
  return sql`CASE
    WHEN EXISTS (SELECT 1 FROM order_lines typed WHERE typed.order_id = ${self}.order_id AND typed.delivery_type = ${type})
      AND NOT EXISTS (
        SELECT 1 FROM order_lines typed
        WHERE typed.order_id = ${self}.order_id AND typed.delivery_type = ${type}
          AND typed.quantity <> ${exitedQuantity(sql`typed.id`)} + ${quantityOn(sql`typed.id`)}
      )
      AND NOT EXISTS (SELECT 1 FROM cancellation_requests earlier WHERE earlier.order_id = ${self}.order_id AND earlier.status = 'approved' AND earlier.${refunded} > 0)
      AND NOT EXISTS (SELECT 1 FROM return_requests earlier WHERE earlier.order_id = ${self}.order_id AND earlier.status = 'completed' AND earlier.${refunded} > 0)
      AND NOT EXISTS (SELECT 1 FROM shipment_losses earlier WHERE earlier.order_id = ${self}.order_id AND earlier.${refunded} > 0)
      AND NOT EXISTS (SELECT 1 FROM shipment_returns earlier WHERE earlier.order_id = ${self}.order_id AND earlier.status = 'completed' AND earlier.${refunded} > 0)
    THEN (SELECT ${fee} FROM orders WHERE orders.id = ${self}.order_id)
    ELSE 0 END`;
}

/**
 * 確認遺失時，這一類配送的原運費要不要退（INSERT 的值運算式，`itemsJson` 是這案遺失明細的 JSON：`[{orderLineId, quantity}]`）：
 * 這案遺失的明細裡有這一類，且訂單上沒有其他核准的取消、完成的退貨、別案遺失或完成入倉檢查的物流退回已經退過這一類運費（`requestColumn` 欄位 > 0），就退訂單上的這類原運費快照一次；
 * 與全退出的規則不同，遺失只要任一筆該類明細遺失就退整類原運費，即使同類其他商品已送達（設計文件 Q25）。
 * 與 `shippingRefundSql` 互斥：兩邊都以「已退過」的欄位判斷，所以任何先後順序同一類原運費最多退一次。
 */
export function lossShippingRefundSql(orderId: SQL, itemsJson: string, type: DeliveryType, feeColumn: string, requestColumn: string): SQL {
  const fee = sql.raw(feeColumn);
  const refunded = sql.raw(requestColumn);
  return sql`CASE
    WHEN EXISTS (SELECT 1 FROM json_each(${itemsJson}) lost JOIN order_lines typed ON typed.id = json_extract(lost.value, '$.orderLineId') WHERE typed.order_id = ${orderId} AND typed.delivery_type = ${type})
      AND NOT EXISTS (SELECT 1 FROM cancellation_requests earlier WHERE earlier.order_id = ${orderId} AND earlier.status = 'approved' AND earlier.${refunded} > 0)
      AND NOT EXISTS (SELECT 1 FROM return_requests earlier WHERE earlier.order_id = ${orderId} AND earlier.status = 'completed' AND earlier.${refunded} > 0)
      AND NOT EXISTS (SELECT 1 FROM shipment_losses earlier WHERE earlier.order_id = ${orderId} AND earlier.${refunded} > 0)
      AND NOT EXISTS (SELECT 1 FROM shipment_returns earlier WHERE earlier.order_id = ${orderId} AND earlier.status = 'completed' AND earlier.${refunded} > 0)
    THEN (SELECT ${fee} FROM orders WHERE orders.id = ${orderId})
    ELSE 0 END`;
}

/**
 * 物流退回入倉檢查完成時，這一類配送的原運費要不要退（UPDATE `shipment_returns` 的 SET 運算式，被更新的那一案此時還不是 `completed`，所以不在「已退過」的統計裡）：
 * 這案實際收回（`received_quantity` > 0，尋回的遺失品已退過款，不算）的明細裡有這一類，且訂單上沒有其他核准的取消、完成的退貨、確認遺失或別案物流退回已經退過這一類運費（`requestColumn` 欄位 > 0），就退訂單上的這類原運費快照一次；
 * 與全退出的規則不同，物流退回只要任一筆該類明細實際入倉並檢查完成就退整類原運費，即使同類其他商品已送達（設計文件 Q25，優先於 Q15 的一般全退出規則）。
 * 與 `shippingRefundSql`、`lossShippingRefundSql` 互斥：都以「已退過」的欄位判斷，所以任何先後順序同一類原運費最多退一次。
 */
export function shipmentReturnShippingRefundSql(type: DeliveryType, feeColumn: string, requestColumn: string): SQL {
  const fee = sql.raw(feeColumn);
  const refunded = sql.raw(requestColumn);
  return sql`CASE
    WHEN EXISTS (SELECT 1 FROM shipment_return_items this_item JOIN order_lines typed ON typed.id = this_item.order_line_id WHERE this_item.return_id = shipment_returns.id AND this_item.received_quantity > 0 AND typed.delivery_type = ${type})
      AND NOT EXISTS (SELECT 1 FROM cancellation_requests earlier WHERE earlier.order_id = shipment_returns.order_id AND earlier.status = 'approved' AND earlier.${refunded} > 0)
      AND NOT EXISTS (SELECT 1 FROM return_requests earlier WHERE earlier.order_id = shipment_returns.order_id AND earlier.status = 'completed' AND earlier.${refunded} > 0)
      AND NOT EXISTS (SELECT 1 FROM shipment_losses earlier WHERE earlier.order_id = shipment_returns.order_id AND earlier.${refunded} > 0)
      AND NOT EXISTS (SELECT 1 FROM shipment_returns earlier WHERE earlier.order_id = shipment_returns.order_id AND earlier.status = 'completed' AND earlier.${refunded} > 0)
    THEN (SELECT ${fee} FROM orders WHERE orders.id = shipment_returns.order_id)
    ELSE 0 END`;
}
