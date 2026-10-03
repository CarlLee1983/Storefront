import { asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { orderLines, orders } from "../orders/schema";
import { refunds } from "../payments/schema";
import type { RefundStatus } from "../payments/shared";
import type { DeliveryType } from "../shipping/types";
import { shipmentLossItems, shipmentLosses } from "./schema";

export interface LossItemView {
  orderLineId: number;
  productName: string;
  variantLabel: string;
  deliveryType: DeliveryType;
  quantity: number;
  /** 按原實付單價的商品款小計。 */
  amountTwd: number;
}

/** 一案確認遺失的對外檢視；顧客與管理員共用，確認人 email 只有管理員看得到。 */
export interface LossView {
  id: number;
  orderId: number;
  shipmentId: number;
  note: string;
  /** 確認時間，UTC epoch 毫秒。 */
  confirmedAt: number;
  goodsTwd: number;
  shippingTwd: number;
  /** 確認後登記的退款；尚未登記（額度被占用）為 null。 */
  refund: { id: number; amountTwd: number; status: RefundStatus } | null;
  items: LossItemView[];
}

export interface AdminLossView extends LossView {
  actor: string;
  /** 管理員表單一次提交的冪等鍵；重新登記退款時重送同一個確認要帶它。 */
  lossKey: string;
}

/** 退款待辦清單最多列出幾筆（舊的在前）。 */
const LIST_LIMIT = 200;

async function selectViews(db: DrizzleD1Database, where: SQL | undefined, limit?: number): Promise<AdminLossView[]> {
  const rows = await db
    .select({
      id: shipmentLosses.id,
      orderId: shipmentLosses.orderId,
      shipmentId: shipmentLosses.shipmentId,
      note: shipmentLosses.note,
      confirmedAt: shipmentLosses.confirmedAt,
      actor: shipmentLosses.actor,
      lossKey: shipmentLosses.lossKey,
      goodsTwd: shipmentLosses.goodsTwd,
      standardShippingTwd: shipmentLosses.standardShippingTwd,
      largeShippingTwd: shipmentLosses.largeShippingTwd,
      refundId: refunds.id,
      refundAmountTwd: refunds.amountTwd,
      refundStatus: refunds.status,
    })
    .from(shipmentLosses)
    .innerJoin(orders, eq(orders.id, shipmentLosses.orderId))
    .leftJoin(refunds, eq(refunds.shipmentLossId, shipmentLosses.id))
    .where(where)
    .orderBy(asc(shipmentLosses.id))
    .limit(limit ?? -1);
  if (rows.length === 0) return [];
  const items = await db
    .select({
      lossId: shipmentLossItems.lossId,
      orderLineId: shipmentLossItems.orderLineId,
      productName: orderLines.productName,
      variantLabel: orderLines.variantLabel,
      deliveryType: orderLines.deliveryType,
      quantity: shipmentLossItems.quantity,
      amountTwd: sql<number>`${shipmentLossItems.quantity} * ${orderLines.unitPriceTwd}`,
    })
    .from(shipmentLossItems)
    .innerJoin(orderLines, eq(orderLines.id, shipmentLossItems.orderLineId))
    .where(inArray(shipmentLossItems.lossId, rows.map((row) => row.id)))
    .orderBy(asc(shipmentLossItems.id));
  return rows.map(({ standardShippingTwd, largeShippingTwd, refundId, refundAmountTwd, refundStatus, ...row }) => ({
    ...row,
    shippingTwd: standardShippingTwd + largeShippingTwd,
    refund: refundId === null ? null : { id: refundId, amountTwd: refundAmountTwd!, status: refundStatus! },
    items: items.filter((item) => item.lossId === row.id).map(({ lossId: _lossId, ...item }) => item),
  }));
}

/** 顧客自己訂單的確認遺失（不含確認人）；永遠含 `orders.customer_id` 條件。 */
export async function selectMyLosses(db: DrizzleD1Database, customerId: string, orderId: number): Promise<LossView[]> {
  const views = await selectViews(db, sql`${orders.customerId} = ${customerId} AND ${orders.id} = ${orderId}`);
  return views.map(({ actor: _actor, lossKey: _lossKey, ...view }) => view);
}

/** 管理員讀某張訂單的全部確認遺失。 */
export function selectOrderLosses(db: DrizzleD1Database, orderId: number): Promise<AdminLossView[]> {
  return selectViews(db, eq(shipmentLosses.orderId, orderId));
}

/**
 * 已確認遺失、應退金額大於 0、卻沒有對應退款紀錄的案件（可退額度被其他退款占用）：
 * 遺失事實不變，但款項還沒有任何退款在處理，必須列進退款待辦（重送同一確認會再嘗試登記）。
 */
export function selectLossesWithoutRefund(db: DrizzleD1Database): Promise<AdminLossView[]> {
  const unregistered = sql`${shipmentLosses.goodsTwd} + ${shipmentLosses.standardShippingTwd} + ${shipmentLosses.largeShippingTwd} > 0
    AND NOT EXISTS (SELECT 1 FROM refunds WHERE refunds.shipment_loss_id = ${shipmentLosses.id})`;
  return selectViews(db, unregistered, LIST_LIMIT);
}
