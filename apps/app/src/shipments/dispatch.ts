import { and, eq, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { insertShipmentNotice } from "../contact/notices";
import { orderLines, orders, PARTIALLY_SHIPPED, SHIPPED, type OrderStatus } from "../orders/schema";
import { allowedSources, canTransitionTo } from "../orders/transitions";
import { batchAtEffectiveNow, effectiveNow } from "../shared/high-water-mark";
import { fail, ok } from "../shared/result";
import type { DeliveryType } from "../shipping/types";
import { approvedCancelledQuantity, heldByCancellationQuantity } from "../cancellations/queries";
import { dispatchedQuantity } from "./queries";
import { shipments } from "./schema";

export interface DispatchItem {
  orderLineId: number;
  quantity: number;
}

export interface DispatchRequest {
  orderId: number;
  /** 一次提交的冪等鍵（見 `shipments.dispatchKey`）。 */
  dispatchKey: string;
  items: DispatchItem[];
  trackingNumber: string | null;
  /** 大型配送議定的時段（UTC epoch 毫秒）；含大型配送明細的批次必填，其餘不可填。 */
  appointment: { start: number; end: number } | null;
  /** 操作人（管理員 email），寫進批次與庫存流水。 */
  actor: string;
}

export type DispatchFailure =
  | "order_not_found"
  | "order_not_shippable"
  | "dispatch_key_conflict"
  | "shipment_line_invalid"
  | "shipment_quantity_exceeded"
  | "appointment_required"
  | "appointment_not_applicable";

export type DispatchResult =
  | { ok: true; data: { orderId: number; shipmentId: number; status: OrderStatus; replayed: boolean } }
  | { ok: false; reason: DispatchFailure };

/**
 * 管理員交運一批（ADR 0006）：單一 batch，批次的建立與其後每一句都受同一個事實約束，同成同敗：
 * 1. 建立批次：訂單此刻可交運（已付款或部分出貨）、同一冪等鍵還沒有批次、且每筆明細「已交運 + 被取消申請占用（待審與核准）+ 本批」不超過明細數量。
 *    並行的兩次交運，先落地的一方贏，後者看到已交運的數量而被擋下（或同鍵重送時被視為重送）。
 * 2. 寫批次明細、3. 扣實體在庫、4. 寫庫存流水：只在這個批次「還沒有流水」時執行，所以同鍵重送不會重複扣庫。
 *    扣在庫在寫流水之前，流水的 `on_hand_after` 直接讀扣後的在庫數。扣除量就是本批數量；已交運數量隨批次明細增加，
 *    已付款保留同步減少，所以可售數量不變。
 * 5. 訂單狀態：每筆明細都出完轉已出貨，否則轉部分出貨（皆走 `canTransitionTo`）。6. 出貨通知同 batch 寫入，事件鍵冪等。
 * 與取消申請（#116，`cancellations/request.ts`）競爭同一數量時，以這個 batch 的落地順序為準：申請先成立，該數量被占用而不可交運（待審凍結、核准停止履約）；
 * 交運先成立，已交運的數量不再是可取消的未交運數量。訂單「出完」是每筆明細的剩餘數量（扣掉核准取消）都已交運。
 * 結果不以受影響列數判斷，而是 batch 之後讀這個冪等鍵的批次：存在就成功（`replayed` 表示不是這次建立的）。
 */
export async function dispatchShipment(
  d1: D1Database,
  db: DrizzleD1Database,
  request: DispatchRequest,
  now: number,
): Promise<DispatchResult> {
  const { orderId, dispatchKey, items, trackingNumber, appointment, actor } = request;

  const [order] = await db.select({ status: orders.status }).from(orders).where(eq(orders.id, orderId));
  if (!order) return fail("order_not_found");
  // 已出完（或不是已付款）的訂單先回 order_not_shippable，不被後面的輸入檢查蓋掉；同鍵重送已出完的訂單仍回原批次，所以只在沒有該鍵的批次時擋
  const [existing] = await db.select({ id: shipments.id }).from(shipments).where(and(eq(shipments.orderId, orderId), eq(shipments.dispatchKey, dispatchKey)));
  if (!existing && !allowedSources(SHIPPED).includes(order.status)) return fail("order_not_shippable");

  const lines = await db.select({ id: orderLines.id, deliveryType: orderLines.deliveryType }).from(orderLines).where(eq(orderLines.orderId, orderId));
  const deliveryTypes = new Map<number, DeliveryType>(lines.map((line) => [line.id, line.deliveryType]));
  const shipsLarge = items.some((item) => deliveryTypes.get(item.orderLineId) === "large");
  if (items.some((item) => !deliveryTypes.has(item.orderLineId))) return fail("shipment_line_invalid");
  if (shipsLarge && !appointment) return fail("appointment_required");
  if (!shipsLarge && appointment) return fail("appointment_not_applicable");

  const requestHash = await hashRequest(items, trackingNumber, appointment);
  const itemsJson = JSON.stringify(items);
  const shipmentId = sql`(SELECT id FROM shipments WHERE order_id = ${orderId} AND dispatch_key = ${dispatchKey})`;
  // 本次 batch 新建的批次：有內容指紋（遷移補建的舊批次為 null，永遠不會被扣庫）、且還沒有庫存流水。
  // 每個非遷移批次都在建立的同一個 batch 內寫流水，所以「有指紋且沒有流水」只可能是剛剛建立的這一批，重送與舊批次都為假
  const notYetDeducted = sql`(SELECT request_hash FROM shipments WHERE id = ${shipmentId}) IS NOT NULL AND NOT EXISTS (SELECT 1 FROM stock_movements WHERE shipment_id = ${shipmentId})`;
  const reason = `交運扣庫（訂單 #${orderId}）`;

  const results = await batchAtEffectiveNow(d1, now, [
    sql`
      INSERT INTO shipments (order_id, dispatch_key, request_hash, tracking_number, appointment_start, appointment_end, shipped_at, actor)
      SELECT orders.id, ${dispatchKey}, ${requestHash}, ${trackingNumber}, ${appointment?.start ?? null}, ${appointment?.end ?? null}, ${effectiveNow}, ${actor}
      FROM orders
      WHERE orders.id = ${orderId} AND ${canTransitionTo(SHIPPED)}
        AND ${shipmentId} IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM json_each(${itemsJson}) item
          LEFT JOIN order_lines line ON line.id = json_extract(item.value, '$.orderLineId') AND line.order_id = orders.id
          WHERE line.id IS NULL OR ${dispatchedQuantity(sql`line.id`)} + ${heldByCancellationQuantity(sql`line.id`)} + json_extract(item.value, '$.quantity') > line.quantity
        )
    `,
    sql`
      INSERT INTO shipment_items (shipment_id, order_line_id, quantity)
      SELECT ${shipmentId}, json_extract(item.value, '$.orderLineId'), json_extract(item.value, '$.quantity')
      FROM json_each(${itemsJson}) item
      WHERE ${shipmentId} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM shipment_items WHERE shipment_id = ${shipmentId})
    `,
    sql`
      UPDATE product_variants
      SET on_hand = on_hand - (
        SELECT item.quantity FROM shipment_items item JOIN order_lines line ON line.id = item.order_line_id
        WHERE item.shipment_id = ${shipmentId} AND line.variant_id = product_variants.id
      )
      WHERE id IN (
        SELECT line.variant_id FROM shipment_items item JOIN order_lines line ON line.id = item.order_line_id WHERE item.shipment_id = ${shipmentId}
      ) AND ${notYetDeducted}
    `,
    sql`
      INSERT INTO stock_movements (variant_id, kind, delta, on_hand_after, unavailable_after, order_id, shipment_id, actor, reason, created_at)
      SELECT line.variant_id, 'dispatch', -item.quantity, variant.on_hand, variant.unavailable, ${orderId}, item.shipment_id, ${actor}, ${reason}, ${effectiveNow}
      FROM shipment_items item
      JOIN order_lines line ON line.id = item.order_line_id
      JOIN product_variants variant ON variant.id = line.variant_id
      WHERE item.shipment_id = ${shipmentId} AND ${notYetDeducted}
    `,
    sql`
      UPDATE orders SET status = ${SHIPPED}
      WHERE id = ${orderId} AND ${canTransitionTo(SHIPPED)} AND ${shipmentId} IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM order_lines line WHERE line.order_id = orders.id AND line.quantity - ${approvedCancelledQuantity(sql`line.id`)} > ${dispatchedQuantity(sql`line.id`)})
    `,
    sql`
      UPDATE orders SET status = ${PARTIALLY_SHIPPED}
      WHERE id = ${orderId} AND ${canTransitionTo(PARTIALLY_SHIPPED)} AND ${shipmentId} IS NOT NULL
    `,
    insertShipmentNotice(orderId, dispatchKey),
    sql`SELECT shipments.id AS shipmentId, orders.status AS status, shipments.request_hash AS requestHash FROM shipments JOIN orders ON orders.id = shipments.order_id WHERE shipments.order_id = ${orderId} AND shipments.dispatch_key = ${dispatchKey}`,
  ]);

  const created = results[0]!.meta.changes > 0;
  const found = results[results.length - 1]!.results[0] as { shipmentId: number; status: OrderStatus; requestHash: string | null } | undefined;
  if (found && !created && found.requestHash !== requestHash) return fail("dispatch_key_conflict");
  if (found) return ok({ orderId, shipmentId: found.shipmentId, status: found.status, replayed: !created });

  const shippable = await db.select({ id: orders.id }).from(orders).where(sql`${orders.id} = ${orderId} AND ${canTransitionTo(SHIPPED)}`);
  return fail(shippable.length > 0 ? "shipment_quantity_exceeded" : "order_not_shippable");
}

/** 交運內容的 SHA-256 hex（明細依訂單明細編號排序，同樣內容得到同樣指紋）。 */
async function hashRequest(items: DispatchItem[], trackingNumber: string | null, appointment: DispatchRequest["appointment"]): Promise<string> {
  const normalized = JSON.stringify({ items: [...items].sort((a, b) => a.orderLineId - b.orderLineId), trackingNumber, appointment });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
