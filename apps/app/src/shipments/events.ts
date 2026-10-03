import { sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { insertDeliveredNotice, insertDeliveryFailedNotice } from "../contact/notices";
import { batchAtEffectiveNow, effectiveNow } from "../shared/high-water-mark";
import { fail, ok } from "../shared/result";
import { derivedDeliveryStatusSql } from "./queries";
import type { DeliveryStatus, ShipmentEventKind } from "./schema";

export interface ShipmentEventRequest {
  shipmentId: number;
  /** 物流給的事件識別（同一批同一個鍵只會有一筆）。 */
  eventKey: string;
  kind: ShipmentEventKind;
  /** 物流回報事件發生的時間（UTC epoch 毫秒）。 */
  occurredAt: number;
  /** 記錄人（管理員 email）。 */
  actor: string;
}

export type ShipmentEventFailure = "shipment_not_found" | "event_time_invalid" | "event_key_conflict";

export type ShipmentEventResult =
  | { ok: true; data: { shipmentId: number; deliveryStatus: DeliveryStatus; deliveredAt: number | null; replayed: boolean } }
  | { ok: false; reason: ShipmentEventFailure };

/**
 * 記錄一筆物流回報（模擬物流）並重新推導該批的配送進度；單一 batch，事件、進度與通知同成同敗。
 * 進度與實際送達時間一律由全部事件推導，不看到達順序，所以延遲、重送、亂序都不會偽造送達或破壞已確定的進度：
 * - 管理員已確認遺失（`shipment_losses`，見 `shipments/loss.ts`）的批次是 `lost`，優先於所有回報：確認時款項已退、數量已不可再退貨，所以確認之後才到的送達、失敗、再次配送回報只留紀錄
 *   （不改進度、不寄通知；送達回報仍記錄實際送達時間，但遺失的數量不因此回到可退貨或可交付）；確認遺失只看批次有沒有實際送達時間（`delivered_at`）：部分遺失之後才送達的批次，進度仍是 `lost`，但已送達，不能再確認遺失；其餘（未遺失）的數量照常寄送達通知，全數遺失的批次不寄。
 * - 其次，管理員登記物流退回（`shipment_returns`，見 `shipment-returns/declare.ts`；收回結案為 `not_received` 的不算，批次進度重算）的批次是 `returned`，同樣優先於送達、失敗與再次配送回報（優先序：遺失 > 物流退回 > 送達 > 失敗 > 再次配送）：
 *   登記時批次尚未送達，之後才到的回報只留紀錄、不改進度、不寄通知；送達回報仍記錄實際送達時間（已送達的批次不能再登記物流退回），其餘（未退回）的數量照常寄送達通知，全數退回的批次不寄。
 * - 其餘，只要有送達回報就是已送達（終點），實際送達時間取發生最早的一筆；之後才到的失敗、再次配送回報只留紀錄。
 * - 尚未送達時，依發生時間最新的一筆決定：配送失敗 → `delivery_failed`；再次配送或沒有回報 → `in_transit`。
 * 再次配送是同一批原貨再交付，所以這裡不建新批次、不動出貨數量與庫存，也不退款。
 * 送達通知一批一封、配送失敗通知一次回報一封，皆與事件同 batch 寫入、事件鍵冪等；同一事件重送會補回遺失的通知。
 * 發生時間須落在交運時間與現在之間；同一事件鍵帶不同內容回 `event_key_conflict`。
 */
export async function recordShipmentEvent(
  d1: D1Database,
  db: DrizzleD1Database,
  request: ShipmentEventRequest,
  now: number,
): Promise<ShipmentEventResult> {
  const { shipmentId, eventKey, kind, occurredAt, actor } = request;

  const results = await batchAtEffectiveNow(d1, now, [
    sql`
      INSERT INTO shipment_events (shipment_id, event_key, kind, occurred_at, recorded_at, actor)
      SELECT shipments.id, ${eventKey}, ${kind}, ${occurredAt}, ${effectiveNow}, ${actor}
      FROM shipments
      WHERE shipments.id = ${shipmentId}
        AND (shipments.shipped_at IS NULL OR ${occurredAt} >= shipments.shipped_at)
        AND ${occurredAt} <= ${effectiveNow}
      ON CONFLICT (shipment_id, event_key) DO NOTHING
    `,
    sql`
      UPDATE shipments SET
        delivered_at = (SELECT MIN(event.occurred_at) FROM shipment_events event WHERE event.shipment_id = shipments.id AND event.kind = 'delivered'),
        delivery_status = ${derivedDeliveryStatusSql}
      WHERE id = ${shipmentId}
    `,
    insertDeliveredNotice(shipmentId),
    insertDeliveryFailedNotice(shipmentId, eventKey),
    sql`
      SELECT shipments.delivery_status AS deliveryStatus, shipments.delivered_at AS deliveredAt, event.kind AS kind, event.occurred_at AS occurredAt
      FROM shipments LEFT JOIN shipment_events event ON event.shipment_id = shipments.id AND event.event_key = ${eventKey}
      WHERE shipments.id = ${shipmentId}
    `,
  ]);

  const created = results[0]!.meta.changes > 0;
  const found = results[results.length - 1]!.results[0] as { deliveryStatus: DeliveryStatus; deliveredAt: number | null; kind: ShipmentEventKind | null; occurredAt: number | null } | undefined;
  if (!found) return fail("shipment_not_found");
  if (found.kind === null) return fail("event_time_invalid");
  if (!created && (found.kind !== kind || found.occurredAt !== occurredAt)) return fail("event_key_conflict");
  return ok({ shipmentId, deliveryStatus: found.deliveryStatus, deliveredAt: found.deliveredAt, replayed: !created });
}
