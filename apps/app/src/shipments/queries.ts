import { asc, inArray, sql, type SQL } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { orderLines } from "../orders/schema";
import type { DeliveryType } from "../shipping/types";
import { shipmentItems, shipments } from "./schema";

/** 某筆訂單明細已交運的數量（各批次明細加總）；「已交運多少」只在這裡定義，保留與交運的上限檢查都用它。 */
export function dispatchedQuantity(orderLineId: SQL): SQL<number> {
  return sql<number>`COALESCE((SELECT SUM(dispatched.quantity) FROM shipment_items dispatched WHERE dispatched.order_line_id = ${orderLineId}), 0)`;
}

export interface ShipmentView {
  id: number;
  orderId: number;
  trackingNumber: string | null;
  /** 議定的預約時段（UTC epoch 毫秒）；沒有議定為 null。 */
  appointment: { start: number; end: number } | null;
  /** 交運時間，UTC epoch 毫秒；遷移補建的舊批次若舊訂單沒有出貨時間為 null（不編造）。 */
  shippedAt: number | null;
  items: { orderLineId: number; productName: string; variantLabel: string; quantity: number; deliveryType: DeliveryType }[];
}

/** 一批訂單的出貨批次（舊的在前），依訂單編號分組；沒有批次的訂單不在結果裡。 */
export async function selectShipmentsByOrder(db: DrizzleD1Database, orderIds: number[]): Promise<Map<number, ShipmentView[]>> {
  const result = new Map<number, ShipmentView[]>();
  if (orderIds.length === 0) return result;
  const rows = await db
    .select({
      id: shipments.id,
      orderId: shipments.orderId,
      trackingNumber: shipments.trackingNumber,
      appointmentStart: shipments.appointmentStart,
      appointmentEnd: shipments.appointmentEnd,
      shippedAt: shipments.shippedAt,
      orderLineId: shipmentItems.orderLineId,
      productName: orderLines.productName,
      variantLabel: orderLines.variantLabel,
      quantity: shipmentItems.quantity,
      deliveryType: orderLines.deliveryType,
    })
    .from(shipments)
    .innerJoin(shipmentItems, sql`${shipmentItems.shipmentId} = ${shipments.id}`)
    .innerJoin(orderLines, sql`${orderLines.id} = ${shipmentItems.orderLineId}`)
    .where(inArray(shipments.orderId, orderIds))
    .orderBy(asc(shipments.id), asc(shipmentItems.id));

  const byId = new Map<number, ShipmentView>();
  for (const { orderLineId, productName, variantLabel, quantity, deliveryType, appointmentStart, appointmentEnd, ...head } of rows) {
    let view = byId.get(head.id);
    if (!view) {
      view = { ...head, appointment: appointmentStart !== null && appointmentEnd !== null ? { start: appointmentStart, end: appointmentEnd } : null, items: [] };
      byId.set(head.id, view);
      result.set(head.orderId, [...(result.get(head.orderId) ?? []), view]);
    }
    view.items.push({ orderLineId, productName, variantLabel, quantity, deliveryType });
  }
  return result;
}
