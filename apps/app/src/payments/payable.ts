import { sql, type SQL } from "drizzle-orm";
import { availableExpr } from "../catalog/stock";
import { allowedSources, canTransitionTo } from "../orders/transitions";
import { EXPIRED, PENDING_PAYMENT, type OrderStatus } from "../orders/schema";

/**
 * 訂單「現在可以發起付款、也可以因付款成功而轉為已付款」的來源狀態：只有待付款。
 *
 * 狀態轉換表（`orders/transitions.ts`）允許兩個來源轉為已付款：待付款與已逾期（遲到的付款成功，ADR 0001）。
 * 這裡明確限縮在待付款，所以發起付款不會對已逾期的訂單開放；已逾期只能經 `LATE_SUCCESS_FROM` 的重新保留路徑轉為已付款。
 * 兩份來源都要「同時」是轉換表允許的，轉換表改了這裡自動跟著變。
 */
const PAYABLE_FROM: readonly OrderStatus[] = [PENDING_PAYMENT];

/** 遲到的付款成功（ADR 0001）能重新保留的來源狀態：只有已逾期；已取消不適用（終點，一律退款）。 */
const LATE_SUCCESS_FROM: readonly OrderStatus[] = [EXPIRED];

/** WHERE 片段（訂單自己的 `status` 欄位）：現在的狀態屬於 `from`，且轉換表允許它轉為已付款。 */
function payableFromSql(from: readonly OrderStatus[]): SQL {
  return sql`(${canTransitionTo("paid")} AND status IN (${sql.join(from.map((source) => sql`${source}`), sql`, `)}))`;
}

export function isPayableStatus(status: OrderStatus): boolean {
  return PAYABLE_FROM.includes(status) && allowedSources("paid").includes(status);
}

/** WHERE 片段（訂單自己的 `status` 欄位）：這張訂單現在能發起付款、也能因付款成功而直接轉為已付款。 */
export function payableStatusSql(): SQL {
  return payableFromSql(PAYABLE_FROM);
}

/** WHERE 片段（訂單自己的 `status` 欄位）：這張訂單是已逾期，遲到的付款成功可以嘗試重新保留。 */
export function lateSuccessStatusSql(): SQL {
  return payableFromSql(LATE_SUCCESS_FROM);
}

/**
 * WHERE 片段：訂單 `orderId` 的「每一筆」明細都能重新保留，即可售數量（在庫數 − 不可售數量 − 其他待付款與已付款訂單的保留）≥ 明細數量。
 * 呼叫端的訂單此時是已逾期，本身不在保留裡，所以不必扣掉自己。可售數量的算法只在 `catalog/stock.ts` 定義。
 * 這是條件的一部分、與轉換寫在同一句 UPDATE：判定發生在寫入當下，不能先讀可售數量再寫。
 */
export function everyLineReclaimableSql(orderId: number): SQL {
  return sql`NOT EXISTS (
    SELECT 1 FROM order_lines line
    JOIN product_variants stocked ON stocked.id = line.variant_id
    WHERE line.order_id = ${orderId} AND ${availableExpr(sql`stocked.on_hand`, sql`stocked.id`)} < line.quantity
  )`;
}
