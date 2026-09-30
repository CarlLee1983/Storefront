import { sql, type SQL } from "drizzle-orm";
import { allowedSources, canTransitionTo } from "../orders/transitions";
import { PENDING_PAYMENT, type OrderStatus } from "../orders/schema";

/**
 * 「付款成功可以讓訂單轉為已付款」的來源狀態，發起付款與套用付款結果共用這一處。
 *
 * 狀態轉換表（`orders/transitions.ts`）允許「已逾期 → 已付款」（遲到的付款成功，ADR 0001），但那一段要先重新保留庫存、
 * 保留不到就退款，屬於 #11。本票只接受「待付款 → 已付款」：付款成功落在已逾期的訂單上，仍走「非待付款」分支
 * （付款記為成功、訂單與庫存不動、記一行 log 交給 #11）。所以來源要「同時」是轉換表允許的、又明確限縮在待付款；
 * #11 接手時只需放寬這裡的限縮。
 */
const SETTLE_ONLY_FROM: readonly OrderStatus[] = [PENDING_PAYMENT];

export function isPayableStatus(status: OrderStatus): boolean {
  return SETTLE_ONLY_FROM.includes(status) && allowedSources("paid").includes(status);
}

/** WHERE 片段（訂單自己的 `status` 欄位）：這張訂單現在能因付款成功而轉為已付款。 */
export function payableStatusSql(): SQL {
  return sql`(${canTransitionTo("paid")} AND status IN (${sql.join(SETTLE_ONLY_FROM.map((source) => sql`${source}`), sql`, `)}))`;
}
