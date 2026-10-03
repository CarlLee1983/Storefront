import { asc, desc, eq, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { approvedCancelledQuantity, pendingCancellationQuantity } from "../cancellations/queries";
import { completedReturnedQuantity, openReturnQuantity } from "../returns/queries";
import { currentCover } from "../images/cover-query";
import { dispatchedQuantity, lostQuantity } from "../shipments/queries";
import type { OrderView } from "./queries";
import { user } from "../auth/schema";
import { paymentNeedsAttentionSql } from "../payments/attention";
import { orderLines, orders, type OrderStatus } from "./schema";

export interface AdminOrderSummary {
  id: number;
  status: OrderStatus;
  totalTwd: number;
  /** 顧客識別：登入時取得的 email（姓名可能重複、也可由顧客自訂，email 才能認出是誰）。 */
  customerEmail: string;
  /** 成立時間，UTC epoch 毫秒。 */
  createdAt: number;
  /** 有付款成功但未處理（見 `payments/attention.ts`）；清單上標「需要處理」。 */
  needsAttention: boolean;
  lines: OrderView["lines"];
}

/**
 * 清單只取最新這麼多筆：不分頁的清單會隨訂單數無限長，超過這個量級（幾百張）就該做分頁或搜尋，
 * 那不在 #12 的範圍；門檻先擋住單次回應與頁面失控。
 */
export const ADMIN_ORDER_LIST_LIMIT = 200;

/** 所有顧客的訂單，新的在前，最多 `ADMIN_ORDER_LIST_LIMIT` 筆；`status` 給了就只列該狀態。 */
export async function selectOrdersForAdmin(db: DrizzleD1Database, status?: OrderStatus): Promise<AdminOrderSummary[]> {
  const summaries = await db
    .select({
      id: orders.id,
      status: orders.status,
      totalTwd: orders.totalTwd,
      customerEmail: user.email,
      createdAt: orders.createdAt,
      needsAttention: sql<boolean>`EXISTS (SELECT 1 FROM payments WHERE payments.order_id = ${orders.id} AND ${paymentNeedsAttentionSql()})`.mapWith(Boolean),
    })
    .from(orders)
    // 顧客不會被刪除（Better Auth 帳號不提供刪除），訂單一定對得到顧客，所以 innerJoin 不會漏掉訂單
    .innerJoin(user, eq(user.id, orders.customerId))
    .where(status === undefined ? undefined : eq(orders.status, status))
    .orderBy(desc(orders.id))
    .limit(ADMIN_ORDER_LIST_LIMIT);
  if (summaries.length === 0) return [];
  // One bounded query for all returned orders, rather than one query per order or line.
  const lines = await db.select({
    orderId: orderLines.orderId, id: orderLines.id, productId: orderLines.productId, variantId: orderLines.variantId, productName: orderLines.productName, variantLabel: orderLines.variantLabel,
    quantity: orderLines.quantity, unitPriceTwd: orderLines.unitPriceTwd, deliveryType: orderLines.deliveryType, shippedQuantity: dispatchedQuantity(sql`${orderLines.id}`),
    cancelledQuantity: approvedCancelledQuantity(sql`${orderLines.id}`), pendingCancellationQuantity: pendingCancellationQuantity(sql`${orderLines.id}`),
    returnedQuantity: completedReturnedQuantity(sql`${orderLines.id}`), openReturnQuantity: openReturnQuantity(sql`${orderLines.id}`), lostQuantity: lostQuantity(sql`${orderLines.id}`),
    cover: currentCover(sql`${orderLines.productId}`),
  }).from(orderLines).where(sql`${orderLines.orderId} IN (SELECT value FROM json_each(${JSON.stringify(summaries.map(order => order.id))}))`).orderBy(asc(orderLines.id));
  const grouped = new Map<number, OrderView["lines"]>();
  for (const { orderId, ...line } of lines) {
    const group = grouped.get(orderId) ?? [];
    group.push(line);
    grouped.set(orderId, group);
  }
  return summaries.map(order => ({ ...order, lines: grouped.get(order.id) ?? [] }));
}
