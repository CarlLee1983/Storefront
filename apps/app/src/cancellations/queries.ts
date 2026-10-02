import { asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { user } from "../auth/schema";
import { orderLines, orders } from "../orders/schema";
import { refunds } from "../payments/schema";
import type { RefundStatus } from "../payments/shared";
import type { DeliveryType } from "../shipping/types";
import { cancellationRequestItems, cancellationRequests, type CancellationStatus } from "./schema";

/**
 * 某筆訂單明細已核准取消的數量（核准案件的明細加總）：核准即停止履約、釋放保留（ADR 0007）。
 * 保留與「訂單是否出完」都減去它（見 `catalog/stock.ts`、`shipments/dispatch.ts`、`cancellations/decide.ts`）。
 */
export function approvedCancelledQuantity(orderLineId: SQL): SQL<number> {
  return sql<number>`COALESCE((SELECT SUM(cancelled.quantity) FROM cancellation_request_items cancelled JOIN cancellation_requests cancelled_request ON cancelled_request.id = cancelled.request_id WHERE cancelled.order_line_id = ${orderLineId} AND cancelled_request.status = 'approved'), 0)`;
}

/** 某筆訂單明細被取消申請占用的數量：待審（凍結交運、仍占保留）加核准。交運與新申請都只能動「明細數量 − 已交運 − 占用」。 */
export function heldByCancellationQuantity(orderLineId: SQL): SQL<number> {
  return sql<number>`COALESCE((SELECT SUM(held.quantity) FROM cancellation_request_items held JOIN cancellation_requests held_request ON held_request.id = held.request_id WHERE held.order_line_id = ${orderLineId} AND held_request.status IN ('pending', 'approved')), 0)`;
}

/** 某筆訂單明細待審中的數量（凍結交運，顧客與管理員畫面顯示用）。 */
export function pendingCancellationQuantity(orderLineId: SQL): SQL<number> {
  return sql<number>`COALESCE((SELECT SUM(waiting.quantity) FROM cancellation_request_items waiting JOIN cancellation_requests waiting_request ON waiting_request.id = waiting.request_id WHERE waiting.order_line_id = ${orderLineId} AND waiting_request.status = 'pending'), 0)`;
}

export interface CancellationItemView {
  orderLineId: number;
  productName: string;
  variantLabel: string;
  deliveryType: DeliveryType;
  quantity: number;
  /** 按原實付單價（下單當時的單價快照）的商品款小計。 */
  amountTwd: number;
}

/** 一案取消申請的對外檢視；顧客與管理員共用，審核人 email 只有管理員看得到（`decidedBy`）。 */
export interface CancellationView {
  id: number;
  orderId: number;
  status: CancellationStatus;
  reason: string;
  /** 申請時間，UTC epoch 毫秒。 */
  requestedAt: number;
  /** 審核時間，UTC epoch 毫秒；待審為 null。 */
  decidedAt: number | null;
  decisionNote: string | null;
  /** 核准時算定的退款拆分；待審與拒絕為 null。 */
  goodsTwd: number | null;
  shippingTwd: number | null;
  /** 核准後登記的退款；尚未登記（待審、拒絕，或核准時額度不足）為 null。 */
  refund: { id: number; amountTwd: number; status: RefundStatus } | null;
  items: CancellationItemView[];
}

export interface AdminCancellationView extends CancellationView {
  decidedBy: string | null;
  customerEmail: string;
}

/**
 * 取消申請及其明細、退款，依申請編號舊的在前。`where` 決定範圍（顧客自己的、某張訂單、待審）；
 * 顧客路徑永遠含 `orders.customer_id` 條件，不洩漏別人的案件。
 */
async function selectViews(db: DrizzleD1Database, where: SQL | undefined, limit?: number): Promise<AdminCancellationView[]> {
  const rows = await db
    .select({
      id: cancellationRequests.id,
      orderId: cancellationRequests.orderId,
      status: cancellationRequests.status,
      reason: cancellationRequests.reason,
      requestedAt: cancellationRequests.requestedAt,
      decidedAt: cancellationRequests.decidedAt,
      decidedBy: cancellationRequests.decidedBy,
      decisionNote: cancellationRequests.decisionNote,
      goodsTwd: cancellationRequests.goodsTwd,
      standardShippingTwd: cancellationRequests.standardShippingTwd,
      largeShippingTwd: cancellationRequests.largeShippingTwd,
      customerEmail: user.email,
      refundId: refunds.id,
      refundAmountTwd: refunds.amountTwd,
      refundStatus: refunds.status,
    })
    .from(cancellationRequests)
    .innerJoin(orders, eq(orders.id, cancellationRequests.orderId))
    .innerJoin(user, eq(user.id, orders.customerId))
    .leftJoin(refunds, eq(refunds.cancellationRequestId, cancellationRequests.id))
    .where(where)
    .orderBy(asc(cancellationRequests.id))
    .limit(limit ?? -1);
  if (rows.length === 0) return [];
  const items = await db
    .select({
      requestId: cancellationRequestItems.requestId,
      orderLineId: cancellationRequestItems.orderLineId,
      productName: orderLines.productName,
      variantLabel: orderLines.variantLabel,
      deliveryType: orderLines.deliveryType,
      quantity: cancellationRequestItems.quantity,
      amountTwd: sql<number>`${cancellationRequestItems.quantity} * ${orderLines.unitPriceTwd}`,
    })
    .from(cancellationRequestItems)
    .innerJoin(orderLines, eq(orderLines.id, cancellationRequestItems.orderLineId))
    .where(inArray(cancellationRequestItems.requestId, rows.map((row) => row.id)))
    .orderBy(asc(cancellationRequestItems.id));
  return rows.map(({ standardShippingTwd, largeShippingTwd, refundId, refundAmountTwd, refundStatus, ...row }) => ({
    ...row,
    shippingTwd: standardShippingTwd === null || largeShippingTwd === null ? null : standardShippingTwd + largeShippingTwd,
    refund: refundId === null ? null : { id: refundId, amountTwd: refundAmountTwd!, status: refundStatus! },
    items: items.filter((item) => item.requestId === row.id).map(({ requestId: _requestId, ...item }) => item),
  }));
}

/** 顧客自己訂單的取消申請（不含審核人與顧客 email）；`orderId` 再收窄到某一張。 */
export async function selectMyCancellations(db: DrizzleD1Database, customerId: string, orderId?: number): Promise<CancellationView[]> {
  const views = await selectViews(db, sql`${orders.customerId} = ${customerId} AND (${orderId ?? null} IS NULL OR ${orders.id} = ${orderId ?? null})`);
  return views.map(({ decidedBy: _decidedBy, customerEmail: _customerEmail, ...view }) => view);
}

/** 管理員讀某張訂單的全部取消申請。 */
export function selectOrderCancellations(db: DrizzleD1Database, orderId: number): Promise<AdminCancellationView[]> {
  return selectViews(db, eq(cancellationRequests.orderId, orderId));
}

/** 取消審核待辦清單最多列出幾筆（舊的在前），其餘以 `omitted` 回報筆數。 */
const REVIEW_LIMIT = 200;

/** 管理員的取消審核待辦：所有待審申請。 */
export async function selectCancellationsToReview(db: DrizzleD1Database): Promise<{ cancellations: AdminCancellationView[]; omitted: number }> {
  const pending = eq(cancellationRequests.status, "pending");
  const cancellations = await selectViews(db, pending, REVIEW_LIMIT);
  const [{ total } = { total: 0 }] = await db.select({ total: sql<number>`count(*)` }).from(cancellationRequests).where(pending);
  return { cancellations, omitted: Math.max(0, total - cancellations.length) };
}
