import { asc, inArray, sql, type SQL } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { orderLines } from "../orders/schema";
import type { DeliveryType } from "../shipping/types";
import { shipmentEvents, shipmentItems, shipments, type DeliveryStatus, type ShipmentEventKind } from "./schema";

/** 某筆訂單明細已交運的數量（各批次明細加總）；「已交運多少」只在這裡定義，保留與交運的上限檢查都用它。 */
export function dispatchedQuantity(orderLineId: SQL): SQL<number> {
  return sql<number>`COALESCE((SELECT SUM(dispatched.quantity) FROM shipment_items dispatched WHERE dispatched.order_line_id = ${orderLineId}), 0)`;
}

/**
 * 一筆物流回報。`noticeExpected` 是這筆回報「應該有通知信」（與寫信同一個條件：送達回報；或是批次未送達、且是發生時間最新的配送失敗回報）；
 * `noticeMessageId` 是它對應的通知信，應有而為 null 才是漏通知，給管理員查證；不應有的（再次配送、已被後續回報取代或已送達）不算缺漏。
 */
export interface ShipmentEventView {
  id: number;
  eventKey: string;
  kind: ShipmentEventKind;
  /** 物流回報事件發生的時間，UTC epoch 毫秒。 */
  occurredAt: number;
  /** 系統收到並記錄的時間，UTC epoch 毫秒。 */
  recordedAt: number;
  noticeExpected: boolean;
  noticeMessageId: number | null;
}

export interface ShipmentView {
  id: number;
  orderId: number;
  trackingNumber: string | null;
  /** 議定的預約時段（UTC epoch 毫秒）；沒有議定為 null。 */
  appointment: { start: number; end: number } | null;
  /** 交運時間，UTC epoch 毫秒；遷移補建的舊批次若舊訂單沒有出貨時間為 null（不編造）。 */
  shippedAt: number | null;
  /** 配送進度（由物流回報推導，見 `shipments/events.ts`）。 */
  deliveryStatus: DeliveryStatus;
  /** 實際送達時間，UTC epoch 毫秒；未送達為 null。 */
  deliveredAt: number | null;
  /** 物流回報（依發生時間，舊的在前）。 */
  events: ShipmentEventView[];
  items: { orderLineId: number; productName: string; variantLabel: string; quantity: number; deliveryType: DeliveryType }[];
}

/** 條件：外層以 `alias` 引用的回報，是同一批發生時間最新的回報（同時間則較晚到者為新）。通知的寫入條件與管理端的 `noticeExpected` 共用它。 */
export function isLatestEvent(alias: string): SQL {
  const outer = sql.raw(alias);
  return sql`NOT EXISTS (
    SELECT 1 FROM shipment_events later WHERE later.shipment_id = ${outer}.shipment_id
      AND (later.occurred_at > ${outer}.occurred_at OR (later.occurred_at = ${outer}.occurred_at AND later.id > ${outer}.id))
  )`;
}

/** 一批訂單的出貨批次（舊的在前），依訂單編號分組；沒有批次的訂單不在結果裡。 */
export async function selectShipmentsByOrder(db: DrizzleD1Database, orderIds: number[], { withEvents }: { withEvents: boolean }): Promise<Map<number, ShipmentView[]>> {
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
      deliveryStatus: shipments.deliveryStatus,
      deliveredAt: shipments.deliveredAt,
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
      view = { ...head, events: [], appointment: appointmentStart !== null && appointmentEnd !== null ? { start: appointmentStart, end: appointmentEnd } : null, items: [] };
      byId.set(head.id, view);
      result.set(head.orderId, [...(result.get(head.orderId) ?? []), view]);
    }
    view.items.push({ orderLineId, productName, variantLabel, quantity, deliveryType });
  }

  if (!withEvents || byId.size === 0) return result;
  const events = await db
    .select({
      id: shipmentEvents.id,
      shipmentId: shipmentEvents.shipmentId,
      eventKey: shipmentEvents.eventKey,
      kind: shipmentEvents.kind,
      occurredAt: shipmentEvents.occurredAt,
      recordedAt: shipmentEvents.recordedAt,
      noticeExpected: sql<boolean>`(shipment_events.kind = 'delivered' OR (
        shipment_events.kind = 'delivery_failed'
        AND (SELECT delivery_status FROM shipments WHERE shipments.id = shipment_events.shipment_id) <> 'delivered'
        AND ${isLatestEvent("shipment_events")}
      ))`.mapWith(Boolean),
      noticeMessageId: sql<number | null>`(SELECT mail.id FROM mail_messages mail WHERE mail.event_key = CASE shipment_events.kind
        WHEN 'delivered' THEN 'shipment_delivered:' || shipment_events.shipment_id
        WHEN 'delivery_failed' THEN 'shipment_delivery_failed:' || shipment_events.shipment_id || ':' || shipment_events.event_key
      END)`,
    })
    .from(shipmentEvents)
    .where(inArray(shipmentEvents.shipmentId, [...byId.keys()]))
    .orderBy(asc(shipmentEvents.occurredAt), asc(shipmentEvents.id));
  for (const { shipmentId, ...event } of events) byId.get(shipmentId)?.events.push(event);
  return result;
}
