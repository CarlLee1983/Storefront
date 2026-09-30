import { sql, type SQL } from "drizzle-orm";
import type { OrderStatus } from "./schema";

/**
 * 訂單狀態轉換的唯一來源（CONTEXT.md 與 ADR 0001）：鍵是來源狀態，值是能轉去的狀態。
 * 已逾期還能轉為已付款（遲到的付款成功）；已取消與已出貨是終點。
 * 所有改訂單狀態的 UPDATE 都必須用 `canTransitionTo` 產生來源條件，不各自手寫狀態判斷。
 */
export const ALLOWED_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  pending_payment: ["paid", "expired", "cancelled"],
  expired: ["paid"],
  paid: ["shipped"],
  shipped: [],
  cancelled: [],
};

/** 能轉到 `target` 的來源狀態。 */
export function allowedSources(target: OrderStatus): OrderStatus[] {
  return (Object.keys(ALLOWED_TRANSITIONS) as OrderStatus[]).filter((from) => ALLOWED_TRANSITIONS[from].includes(target));
}

/** UPDATE 的 WHERE 片段：訂單目前狀態必須是能轉到 `target` 的來源（無來源時恆為假）。 */
export function canTransitionTo(target: OrderStatus): SQL {
  const sources = allowedSources(target);
  if (sources.length === 0) return sql`0`;
  return sql`status IN (${sql.join(sources.map((source) => sql`${source}`), sql`, `)})`;
}
