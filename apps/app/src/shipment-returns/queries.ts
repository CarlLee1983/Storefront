import { asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { orderLines, orders } from "../orders/schema";
import { refunds } from "../payments/schema";
import type { RefundStatus } from "../payments/shared";
import type { DeliveryType } from "../shipping/types";
import { shipmentReturnItems, shipmentReturns, type ShipmentReturnStatus } from "./schema";

export interface ShipmentReturnItemView {
  orderLineId: number;
  productName: string;
  variantLabel: string;
  deliveryType: DeliveryType;
  /** 登記退回的數量（收回後按原實付單價退款）。 */
  quantity: number;
  /** 其中先前確認遺失並已退款、被物流尋回的數量（入庫但不再退款）。 */
  foundLostQuantity: number;
  /** 實際收到的數量與其中尋回的遺失品數量；尚未記錄收回為 null。 */
  receivedQuantity: number | null;
  receivedFoundLostQuantity: number | null;
  /** 檢查結果：良品轉可售、損壞品隔離的數量；尚未檢查為 null。 */
  sellableQuantity: number | null;
  damagedQuantity: number | null;
  /** 按原實付單價的商品款小計：收回前是登記退回的數量，收回後是實際收到的數量（完成時即實際退款的商品款）。 */
  amountTwd: number;
}

/** 一案物流退回的對外檢視；顧客與管理員共用，操作人 email 與備註只有管理員看得到。 */
export interface ShipmentReturnView {
  id: number;
  orderId: number;
  shipmentId: number;
  status: ShipmentReturnStatus;
  /** 登記時間，UTC epoch 毫秒。 */
  declaredAt: number;
  receivedAt: number | null;
  inspectedAt: number | null;
  /** 檢查完成時算定的退款拆分；完成之前為 null。 */
  goodsTwd: number | null;
  shippingTwd: number | null;
  /** 檢查完成後登記的退款；尚未登記（還沒完成，或額度被占用）為 null。 */
  refund: { id: number; amountTwd: number; status: RefundStatus } | null;
  items: ShipmentReturnItemView[];
}

export interface AdminShipmentReturnView extends ShipmentReturnView {
  note: string;
  actor: string;
  /** 管理員表單一次提交的冪等鍵。 */
  returnKey: string;
  receiptNote: string | null;
  receivedBy: string | null;
  inspectionNote: string | null;
  inspectedBy: string | null;
}

/** 退款待辦清單最多列出幾筆（舊的在前）。 */
const LIST_LIMIT = 200;

async function selectViews(db: DrizzleD1Database, where: SQL | undefined, limit?: number): Promise<AdminShipmentReturnView[]> {
  const rows = await db
    .select({
      id: shipmentReturns.id,
      orderId: shipmentReturns.orderId,
      shipmentId: shipmentReturns.shipmentId,
      status: shipmentReturns.status,
      returnKey: shipmentReturns.returnKey,
      note: shipmentReturns.note,
      declaredAt: shipmentReturns.declaredAt,
      actor: shipmentReturns.actor,
      receivedAt: shipmentReturns.receivedAt,
      receivedBy: shipmentReturns.receivedBy,
      receiptNote: shipmentReturns.receiptNote,
      inspectedAt: shipmentReturns.inspectedAt,
      inspectedBy: shipmentReturns.inspectedBy,
      inspectionNote: shipmentReturns.inspectionNote,
      goodsTwd: shipmentReturns.goodsTwd,
      standardShippingTwd: shipmentReturns.standardShippingTwd,
      largeShippingTwd: shipmentReturns.largeShippingTwd,
      refundId: refunds.id,
      refundAmountTwd: refunds.amountTwd,
      refundStatus: refunds.status,
    })
    .from(shipmentReturns)
    .innerJoin(orders, eq(orders.id, shipmentReturns.orderId))
    .leftJoin(refunds, eq(refunds.shipmentReturnId, shipmentReturns.id))
    .where(where)
    .orderBy(asc(shipmentReturns.id))
    .limit(limit ?? -1);
  if (rows.length === 0) return [];
  const items = await db
    .select({
      returnId: shipmentReturnItems.returnId,
      orderLineId: shipmentReturnItems.orderLineId,
      productName: orderLines.productName,
      variantLabel: orderLines.variantLabel,
      deliveryType: orderLines.deliveryType,
      quantity: shipmentReturnItems.quantity,
      foundLostQuantity: shipmentReturnItems.foundLostQuantity,
      receivedQuantity: shipmentReturnItems.receivedQuantity,
      receivedFoundLostQuantity: shipmentReturnItems.receivedFoundLostQuantity,
      sellableQuantity: shipmentReturnItems.sellableQuantity,
      damagedQuantity: shipmentReturnItems.damagedQuantity,
      amountTwd: sql<number>`COALESCE(${shipmentReturnItems.receivedQuantity}, ${shipmentReturnItems.quantity}) * ${orderLines.unitPriceTwd}`,
    })
    .from(shipmentReturnItems)
    .innerJoin(orderLines, eq(orderLines.id, shipmentReturnItems.orderLineId))
    .where(inArray(shipmentReturnItems.returnId, rows.map((row) => row.id)))
    .orderBy(asc(shipmentReturnItems.id));
  return rows.map(({ standardShippingTwd, largeShippingTwd, refundId, refundAmountTwd, refundStatus, ...row }) => ({
    ...row,
    shippingTwd: standardShippingTwd === null || largeShippingTwd === null ? null : standardShippingTwd + largeShippingTwd,
    refund: refundId === null ? null : { id: refundId, amountTwd: refundAmountTwd!, status: refundStatus! },
    items: items.filter((item) => item.returnId === row.id).map(({ returnId: _returnId, ...item }) => item),
  }));
}

/** 顧客自己訂單的物流退回（不含操作人、冪等鍵與管理員備註）；永遠含 `orders.customer_id` 條件。 */
export async function selectMyShipmentReturns(db: DrizzleD1Database, customerId: string, orderId: number): Promise<ShipmentReturnView[]> {
  const views = await selectViews(db, sql`${orders.customerId} = ${customerId} AND ${orders.id} = ${orderId}`);
  return views.map(({ note: _note, actor: _actor, returnKey: _returnKey, receiptNote: _receiptNote, receivedBy: _receivedBy, inspectionNote: _inspectionNote, inspectedBy: _inspectedBy, ...view }) => view);
}

/** 管理員讀某張訂單的全部物流退回。 */
export function selectOrderShipmentReturns(db: DrizzleD1Database, orderId: number): Promise<AdminShipmentReturnView[]> {
  return selectViews(db, eq(shipmentReturns.orderId, orderId));
}

/**
 * 已完成入倉檢查、應退金額大於 0、卻沒有對應退款紀錄的物流退回（可退額度被其他退款占用，或訂單沒有可綁定的付款）：
 * 實物結果不變，但款項還沒有任何退款在處理，必須列進退款待辦（重送檢查記錄會再嘗試登記）。
 */
export function selectShipmentReturnsWithoutRefund(db: DrizzleD1Database): Promise<AdminShipmentReturnView[]> {
  const unregistered = sql`${shipmentReturns.status} = 'completed'
    AND ${shipmentReturns.goodsTwd} + ${shipmentReturns.standardShippingTwd} + ${shipmentReturns.largeShippingTwd} > 0
    AND NOT EXISTS (SELECT 1 FROM refunds WHERE refunds.shipment_return_id = ${shipmentReturns.id})`;
  return selectViews(db, unregistered, LIST_LIMIT);
}
