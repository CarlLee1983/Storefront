import { sql, type SQL } from "drizzle-orm";
import { approvedCancelledQuantity } from "../cancellations/queries";
import { completedReturnedQuantity } from "../returns/queries";
import type { DeliveryType } from "../shipping/types";

/**
 * 某筆訂單明細已「退出履約」的數量：核准取消的（停止履約）加完成收回檢查的退貨。運費退款的判斷以它為準：
 * 同一配送類型每筆明細都全數退出，才符合「全退出」（待審、在途與待檢的數量尚未退出）。
 */
export function exitedQuantity(orderLineId: SQL): SQL<number> {
  return sql<number>`(${approvedCancelledQuantity(orderLineId)} + ${completedReturnedQuantity(orderLineId)})`;
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
 * 且訂單上沒有其他已核准的取消或已完成的退貨已經退過這一類運費（`requestColumn` 欄位 > 0）。
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
    THEN (SELECT ${fee} FROM orders WHERE orders.id = ${self}.order_id)
    ELSE 0 END`;
}
