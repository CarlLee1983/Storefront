import { asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { user } from "../auth/schema";
import { orderLines, orders } from "../orders/schema";
import { refunds } from "../payments/schema";
import type { RefundStatus } from "../payments/shared";
import type { DeliveryType } from "../shipping/types";
import { returnRequestItems, returnRequests, type ReturnStatus } from "./schema";

/**
 * 某筆訂單明細被退貨申請占用的數量（已交運數量中不能再申請退貨的部分）：待審與核准占用申請數量，
 * 收回後占用實際收到的數量（沒收到的釋出），檢查完成維持實際收到的數量（已退貨，不能再退），拒絕與未收到釋出。
 * 新申請只能動「已交運 − 占用」；同一句條件寫入，所以並行申請與重複申請不會超量。
 */
export function heldByReturnQuantity(orderLineId: SQL): SQL<number> {
  return sql<number>`COALESCE((SELECT SUM(CASE WHEN held_request.status IN ('pending', 'approved') THEN held.quantity ELSE COALESCE(held.received_quantity, 0) END) FROM return_request_items held JOIN return_requests held_request ON held_request.id = held.request_id WHERE held.order_line_id = ${orderLineId} AND held_request.status IN ('pending', 'approved', 'received', 'completed')), 0)`;
}

/**
 * 某批某筆明細被自助退貨占用的數量（`return_request_batches`）：待審、核准、已收回、已完成的申請都算（拒絕與未收到釋出）。
 * 批次沒有分開記錄實際收到的數量，所以部分收回後未收到的部分在明細層釋出（`heldByReturnQuantity`），但該批的自助占用維持申請數量，之後走人工受理。
 */
export function heldByReturnBatchQuantity(orderLineId: SQL, shipmentId: SQL): SQL<number> {
  return sql<number>`COALESCE((SELECT SUM(held_batch.quantity) FROM return_request_batches held_batch JOIN return_requests held_batch_request ON held_batch_request.id = held_batch.request_id WHERE held_batch.order_line_id = ${orderLineId} AND held_batch.shipment_id = ${shipmentId} AND held_batch_request.status IN ('pending', 'approved', 'received', 'completed')), 0)`;
}

/** 某筆訂單明細已完成收回檢查的退貨數量（實際收到並檢查完成）；與核准取消合稱「退出履約」，見 `payments/exit-refund.ts`。 */
export function completedReturnedQuantity(orderLineId: SQL): SQL<number> {
  return sql<number>`COALESCE((SELECT SUM(returned.received_quantity) FROM return_request_items returned JOIN return_requests returned_request ON returned_request.id = returned.request_id WHERE returned.order_line_id = ${orderLineId} AND returned_request.status = 'completed'), 0)`;
}

/** 某筆訂單明細退貨進行中的數量（待審、核准、待檢），顧客與管理員畫面顯示用。 */
export function openReturnQuantity(orderLineId: SQL): SQL<number> {
  return sql<number>`COALESCE((SELECT SUM(CASE WHEN open_request.status IN ('pending', 'approved') THEN open_item.quantity ELSE COALESCE(open_item.received_quantity, 0) END) FROM return_request_items open_item JOIN return_requests open_request ON open_request.id = open_item.request_id WHERE open_item.order_line_id = ${orderLineId} AND open_request.status IN ('pending', 'approved', 'received')), 0)`;
}

/**
 * 某個變體已收回、尚未檢查的數量：在不可售數量裡但還不能報廢（檢查之後才知道是良品還是損壞）。
 * 報廢只能動「不可售 − 待檢」，也就是已檢查確認的損壞品（見 `stock/scrap.ts`）。
 */
export function awaitingInspectionQuantity(variantId: SQL): SQL<number> {
  return sql<number>`COALESCE((SELECT SUM(awaiting.received_quantity) FROM return_request_items awaiting JOIN return_requests awaiting_request ON awaiting_request.id = awaiting.request_id JOIN order_lines awaiting_line ON awaiting_line.id = awaiting.order_line_id WHERE awaiting_line.variant_id = ${variantId} AND awaiting_request.status = 'received'), 0)`;
}

export interface ReturnItemView {
  orderLineId: number;
  productName: string;
  variantLabel: string;
  deliveryType: DeliveryType;
  /** 申請（核准）的數量。 */
  quantity: number;
  /** 實際收到的數量；尚未記錄收回為 null。 */
  receivedQuantity: number | null;
  /** 檢查結果：良品轉可售、損壞品隔離的數量；尚未檢查為 null。 */
  sellableQuantity: number | null;
  damagedQuantity: number | null;
  /** 按原實付單價的商品款小計（申請數量）。 */
  amountTwd: number;
}

/** 一案退貨申請的對外檢視；顧客與管理員共用，操作人 email 只有管理員看得到。 */
export interface ReturnView {
  id: number;
  orderId: number;
  status: ReturnStatus;
  reason: string;
  /** 申請時間，UTC epoch 毫秒。 */
  requestedAt: number;
  decidedAt: number | null;
  decisionNote: string | null;
  receivedAt: number | null;
  inspectedAt: number | null;
  /** 檢查完成時算定的退款拆分；完成之前為 null。 */
  goodsTwd: number | null;
  shippingTwd: number | null;
  /** 檢查完成後登記的退款；尚未登記為 null。 */
  refund: { id: number; amountTwd: number; status: RefundStatus } | null;
  /** 這案是自助申請（逐批在窗口內）；否則是人工受理入口。 */
  selfService: boolean;
  items: ReturnItemView[];
}

export interface AdminReturnView extends ReturnView {
  customerEmail: string;
  decidedBy: string | null;
  receiptNote: string | null;
  receivedBy: string | null;
  inspectionNote: string | null;
  inspectedBy: string | null;
}

async function selectViews(db: DrizzleD1Database, where: SQL | undefined, limit?: number): Promise<AdminReturnView[]> {
  const rows = await db
    .select({
      id: returnRequests.id,
      orderId: returnRequests.orderId,
      status: returnRequests.status,
      reason: returnRequests.reason,
      requestedAt: returnRequests.requestedAt,
      decidedAt: returnRequests.decidedAt,
      decidedBy: returnRequests.decidedBy,
      decisionNote: returnRequests.decisionNote,
      receivedAt: returnRequests.receivedAt,
      receivedBy: returnRequests.receivedBy,
      receiptNote: returnRequests.receiptNote,
      inspectedAt: returnRequests.inspectedAt,
      inspectedBy: returnRequests.inspectedBy,
      inspectionNote: returnRequests.inspectionNote,
      goodsTwd: returnRequests.goodsTwd,
      standardShippingTwd: returnRequests.standardShippingTwd,
      largeShippingTwd: returnRequests.largeShippingTwd,
      selfService: sql<boolean>`EXISTS (SELECT 1 FROM return_request_batches WHERE return_request_batches.request_id = ${returnRequests.id})`.mapWith(Boolean),
      customerEmail: user.email,
      refundId: refunds.id,
      refundAmountTwd: refunds.amountTwd,
      refundStatus: refunds.status,
    })
    .from(returnRequests)
    .innerJoin(orders, eq(orders.id, returnRequests.orderId))
    .innerJoin(user, eq(user.id, orders.customerId))
    .leftJoin(refunds, eq(refunds.returnRequestId, returnRequests.id))
    .where(where)
    .orderBy(asc(returnRequests.id))
    .limit(limit ?? -1);
  if (rows.length === 0) return [];
  const items = await db
    .select({
      requestId: returnRequestItems.requestId,
      orderLineId: returnRequestItems.orderLineId,
      productName: orderLines.productName,
      variantLabel: orderLines.variantLabel,
      deliveryType: orderLines.deliveryType,
      quantity: returnRequestItems.quantity,
      receivedQuantity: returnRequestItems.receivedQuantity,
      sellableQuantity: returnRequestItems.sellableQuantity,
      damagedQuantity: returnRequestItems.damagedQuantity,
      amountTwd: sql<number>`${returnRequestItems.quantity} * ${orderLines.unitPriceTwd}`,
    })
    .from(returnRequestItems)
    .innerJoin(orderLines, eq(orderLines.id, returnRequestItems.orderLineId))
    .where(inArray(returnRequestItems.requestId, rows.map((row) => row.id)))
    .orderBy(asc(returnRequestItems.id));
  return rows.map(({ standardShippingTwd, largeShippingTwd, refundId, refundAmountTwd, refundStatus, ...row }) => ({
    ...row,
    shippingTwd: standardShippingTwd === null || largeShippingTwd === null ? null : standardShippingTwd + largeShippingTwd,
    refund: refundId === null ? null : { id: refundId, amountTwd: refundAmountTwd!, status: refundStatus! },
    items: items.filter((item) => item.requestId === row.id).map(({ requestId: _requestId, ...item }) => item),
  }));
}

/** 顧客自己訂單的退貨申請（不含操作人與顧客 email）；`orderId` 再收窄到某一張。永遠含 `orders.customer_id` 條件。 */
export async function selectMyReturns(db: DrizzleD1Database, customerId: string, orderId?: number): Promise<ReturnView[]> {
  const views = await selectViews(db, sql`${orders.customerId} = ${customerId} AND (${orderId ?? null} IS NULL OR ${orders.id} = ${orderId ?? null})`);
  return views.map(({ customerEmail: _customerEmail, decidedBy: _decidedBy, receivedBy: _receivedBy, receiptNote: _receiptNote, inspectedBy: _inspectedBy, inspectionNote: _inspectionNote, ...view }) => view);
}

/** 管理員讀某張訂單的全部退貨申請。 */
export function selectOrderReturns(db: DrizzleD1Database, orderId: number): Promise<AdminReturnView[]> {
  return selectViews(db, eq(returnRequests.orderId, orderId));
}

/** 管理員單讀一案（寫入後回應、通知用）。 */
export async function selectReturn(db: DrizzleD1Database, requestId: number): Promise<AdminReturnView | undefined> {
  return (await selectViews(db, eq(returnRequests.id, requestId)))[0];
}

/** 退貨待辦清單最多列出幾筆（舊的在前），其餘以 `omitted` 回報筆數。 */
const HANDLE_LIMIT = 200;

/** 管理員的退貨待辦：待審、已核准待收回、已收回待檢查的申請。 */
export async function selectReturnsToHandle(db: DrizzleD1Database): Promise<{ returns: AdminReturnView[]; omitted: number }> {
  const open = inArray(returnRequests.status, ["pending", "approved", "received"]);
  const returnsToHandle = await selectViews(db, open, HANDLE_LIMIT);
  const [{ total } = { total: 0 }] = await db.select({ total: sql<number>`count(*)` }).from(returnRequests).where(open);
  return { returns: returnsToHandle, omitted: Math.max(0, total - returnsToHandle.length) };
}

/**
 * 已完成檢查、應退金額大於 0、卻沒有對應退款紀錄的退貨案（可退額度被其他退款占用，或訂單沒有可綁定的付款）：
 * 實物結果不變，但款項還沒有任何退款在處理，必須列進退款待辦（重送檢查記錄會再嘗試登記）。
 */
export async function selectCompletedWithoutRefund(db: DrizzleD1Database): Promise<AdminReturnView[]> {
  const unregistered = sql`${returnRequests.status} = 'completed'
    AND ${returnRequests.goodsTwd} + ${returnRequests.standardShippingTwd} + ${returnRequests.largeShippingTwd} > 0
    AND NOT EXISTS (SELECT 1 FROM refunds WHERE refunds.return_request_id = ${returnRequests.id})`;
  return selectViews(db, unregistered, HANDLE_LIMIT);
}
