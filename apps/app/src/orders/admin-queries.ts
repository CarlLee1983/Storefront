import { and, asc, desc, eq, lt, sql, type SQL } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { approvedCancelledQuantity, pendingCancellationQuantity } from "../cancellations/queries";
import { completedReturnedQuantity, openReturnQuantity } from "../returns/queries";
import { currentCover } from "../images/cover-query";
import { heldByShipmentReturnQuantity } from "../shipment-returns/quantities";
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

/** 列表每頁筆數。 */
export const ADMIN_ORDER_PAGE_SIZE = 20;

/** 匯出每批筆數：Web 逐批取回，單次回應與 Worker 記憶體都不隨訂單總數成長。 */
export const ADMIN_ORDER_EXPORT_BATCH_SIZE = 500;

/**
 * 查找條件（見 `admin/input.ts` 的 `orderFilterFields`）。列表與匯出共用 `orderFilterWhere`，範圍才會一致。
 * `from` 含、`to` 不含，皆為 UTC epoch 毫秒。
 */
export interface OrderFilter {
  orderId?: number;
  email?: string;
  status?: OrderStatus;
  from?: number;
  to?: number;
}

/** 游標：只取編號小於它的（上一批最後一筆的編號）；編號是主鍵，遞減走過整張表不遺漏、不重複，期間新增的訂單不影響翻頁。 */
export type OrderCursor = { beforeId?: number };

/**
 * 條件轉成 WHERE：全部參數化（email 以 `instr` 比對，不把使用者輸入當 LIKE 樣式）。
 * 都走索引：編號是主鍵；狀態有 `(status, id)` 索引；email 先在顧客表找出符合的顧客，再以 `orders_customer_idx` 對回訂單。
 * 日期區間不直接對 `created_at` 範圍掃描（那會每頁都讀完整區間再排序）：訂單的 `created_at` 是高水位時鐘的有效時間
 * （`placeOrderIfAvailable`，只增不減）、`id` 是 AUTOINCREMENT，兩者同序，所以用 `orders_created_idx` 兩次點查
 * 把日期換成 id 的上下界，再走主鍵範圍（遞減走主鍵、不需要排序）；區間內沒有訂單時子查詢為 NULL，比較不成立、回空。
 * 綁定參數數量固定，不隨結果筆數成長（D1 單句上限 100 個）。
 */
export function orderFilterWhere({ orderId, email, status, from, to, beforeId }: OrderFilter & OrderCursor): SQL | undefined {
  const conditions = [
    orderId === undefined ? undefined : eq(orders.id, orderId),
    email === undefined || email === "" ? undefined : sql`${orders.customerId} IN (SELECT id FROM ${user} WHERE instr(lower(${user.email}), lower(${email})) > 0)`,
    status === undefined ? undefined : eq(orders.status, status),
    from === undefined ? undefined : sql`${orders.id} >= (SELECT first.id FROM orders first WHERE first.created_at >= ${from} ORDER BY first.created_at, first.id LIMIT 1)`,
    to === undefined ? undefined : sql`${orders.id} <= (SELECT last.id FROM orders last WHERE last.created_at < ${to} ORDER BY last.created_at DESC, last.id DESC LIMIT 1)`,
    beforeId === undefined ? undefined : lt(orders.id, beforeId),
  ];
  return and(...conditions);
}

/** 符合條件的訂單，新的在前，一頁 `ADMIN_ORDER_PAGE_SIZE` 筆；多讀一筆判斷是否還有下一頁，`nextBeforeId` 為下一頁的游標（沒有為 null）。 */
export async function selectOrdersForAdmin(db: DrizzleD1Database, filter: OrderFilter & OrderCursor): Promise<{ items: AdminOrderSummary[]; nextBeforeId: number | null }> {
  const found = await db
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
    .where(orderFilterWhere(filter))
    .orderBy(desc(orders.id))
    .limit(ADMIN_ORDER_PAGE_SIZE + 1);
  const summaries = found.slice(0, ADMIN_ORDER_PAGE_SIZE);
  const nextBeforeId = found.length > ADMIN_ORDER_PAGE_SIZE ? summaries[summaries.length - 1]!.id : null;
  return { items: await withLines(db, summaries), nextBeforeId };
}

/** 匯出的一列：一張訂單的付款與各流程進度彙總（數量為各明細加總）。 */
export interface AdminOrderExportRow {
  id: number;
  createdAt: number;
  customerEmail: string;
  status: OrderStatus;
  totalTwd: number;
  needsAttention: boolean;
  /** 成功收款的總額（新台幣整數元）。 */
  paidTwd: number;
  /** 已確認退回的退款總額（新台幣整數元）。 */
  refundedTwd: number;
  orderedQuantity: number;
  shippedQuantity: number;
  cancelledQuantity: number;
  returnedQuantity: number;
  lostQuantity: number;
  shipmentReturnedQuantity: number;
  /** 已開立的發票號碼，多張以空白分隔；沒有為空字串。 */
  invoiceNumbers: string;
  /** 已登記但尚未折讓成功的折讓義務筆數。 */
  pendingAllowances: number;
}

/** 某筆訂單所有明細的某個數量加總（`quantity` 以明細編號算出單筆數量）。 */
const sumOverLines = (quantity: (lineId: SQL) => SQL<number>) =>
  sql<number>`COALESCE((SELECT SUM(${quantity(sql`order_lines.id`)}) FROM order_lines WHERE order_lines.order_id = ${orders.id}), 0)`;

/** 匯出一批：條件與列表相同，新的在前，一批 `ADMIN_ORDER_EXPORT_BATCH_SIZE` 筆；`nextBeforeId` 為下一批的游標（沒有為 null）。 */
export async function selectOrderExportBatch(db: DrizzleD1Database, filter: OrderFilter & OrderCursor): Promise<{ rows: AdminOrderExportRow[]; nextBeforeId: number | null }> {
  const found = await db
    .select({
      id: orders.id,
      createdAt: orders.createdAt,
      customerEmail: user.email,
      status: orders.status,
      totalTwd: orders.totalTwd,
      needsAttention: sql<boolean>`EXISTS (SELECT 1 FROM payments WHERE payments.order_id = ${orders.id} AND ${paymentNeedsAttentionSql()})`.mapWith(Boolean),
      paidTwd: sql<number>`COALESCE((SELECT SUM(payments.amount_twd) FROM payments WHERE payments.order_id = ${orders.id} AND payments.status = 'succeeded'), 0)`,
      refundedTwd: sql<number>`COALESCE((SELECT SUM(refunds.amount_twd) FROM refunds WHERE refunds.order_id = ${orders.id} AND refunds.status = 'succeeded'), 0)`,
      orderedQuantity: sql<number>`(SELECT SUM(order_lines.quantity) FROM order_lines WHERE order_lines.order_id = ${orders.id})`,
      shippedQuantity: sumOverLines(dispatchedQuantity),
      cancelledQuantity: sumOverLines(approvedCancelledQuantity),
      returnedQuantity: sumOverLines(completedReturnedQuantity),
      lostQuantity: sumOverLines(lostQuantity),
      shipmentReturnedQuantity: sumOverLines(heldByShipmentReturnQuantity),
      invoiceNumbers: sql<string>`COALESCE((SELECT group_concat(invoices.invoice_number, ' ') FROM invoices WHERE invoices.order_id = ${orders.id} AND invoices.status = 'issued'), '')`,
      pendingAllowances: sql<number>`(SELECT COUNT(*) FROM allowance_obligations WHERE allowance_obligations.order_id = ${orders.id} AND allowance_obligations.status <> 'issued')`,
    })
    .from(orders)
    .innerJoin(user, eq(user.id, orders.customerId))
    .where(orderFilterWhere(filter))
    .orderBy(desc(orders.id))
    .limit(ADMIN_ORDER_EXPORT_BATCH_SIZE + 1);
  const rows = found.slice(0, ADMIN_ORDER_EXPORT_BATCH_SIZE);
  return { rows, nextBeforeId: found.length > ADMIN_ORDER_EXPORT_BATCH_SIZE ? rows[rows.length - 1]!.id : null };
}

async function withLines(db: DrizzleD1Database, summaries: Omit<AdminOrderSummary, "lines">[]): Promise<AdminOrderSummary[]> {
  if (summaries.length === 0) return [];
  // One bounded query for all returned orders, rather than one query per order or line.
  const lines = await db.select({
    orderId: orderLines.orderId, id: orderLines.id, productId: orderLines.productId, variantId: orderLines.variantId, productName: orderLines.productName, variantLabel: orderLines.variantLabel,
    quantity: orderLines.quantity, unitPriceTwd: orderLines.unitPriceTwd, deliveryType: orderLines.deliveryType, shippedQuantity: dispatchedQuantity(sql`${orderLines.id}`),
    cancelledQuantity: approvedCancelledQuantity(sql`${orderLines.id}`), pendingCancellationQuantity: pendingCancellationQuantity(sql`${orderLines.id}`),
    returnedQuantity: completedReturnedQuantity(sql`${orderLines.id}`), openReturnQuantity: openReturnQuantity(sql`${orderLines.id}`), lostQuantity: lostQuantity(sql`${orderLines.id}`), shipmentReturnedQuantity: heldByShipmentReturnQuantity(sql`${orderLines.id}`),
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
