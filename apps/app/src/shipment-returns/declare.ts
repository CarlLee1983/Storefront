import { eq, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { insertShipmentReturnDeclaredNotice } from "../contact/notices";
import { heldByReturnBatchQuantity, heldByReturnQuantity } from "../returns/queries";
import { batchAtEffectiveNow, effectiveNow } from "../shared/high-water-mark";
import { hashCaseRequest } from "../shared/request-hash";
import { fail, ok } from "../shared/result";
import { dispatchedQuantity, lostInBatchQuantity, lostQuantity } from "../shipments/queries";
import { shipmentItems, shipments } from "../shipments/schema";
import type { DeclareShipmentReturnInput } from "./input";
import { foundLostInBatchQuantity, heldByShipmentReturnQuantity, returnedInBatchQuantity } from "./quantities";

export type DeclareShipmentReturnFailure = "shipment_not_found" | "shipment_delivered" | "return_line_invalid" | "return_quantity_exceeded" | "return_key_conflict";

export type DeclareShipmentReturnResult =
  | { ok: true; data: { returnId: number; /** 這次呼叫不是第一次登記這案（重送）。 */ replayed: boolean } }
  | { ok: false; reason: DeclareShipmentReturnFailure };

/**
 * 管理員登記某一批的部分商品被物流退回倉庫（尚未收到，不動庫存；CONTEXT.md「物流退回」）。單一 batch，同成同敗，是否成立由條件寫入的結果判斷（不先讀再寫）：
 * 1. 建立物流退回案件：批次尚未送達（有實際送達時間就是已送達，已送達是終點；暫時配送失敗不影響），每筆明細都在這一批裡，
 *    且「該批已遺失 + 該批自助退貨占用 + 該批已退回 + 本次」不超過該批數量，「明細已遺失 + 退貨占用 + 物流退回占用 + 本次」不超過明細已交運數量
 *    （與退貨申請 `returns/request.ts`、確認遺失 `shipments/loss.ts` 共用同一份數量，三邊同一句條件寫入互斥）。
 *    尋回的遺失品（`foundLostQuantity`）是先前確認遺失並已退款的數量，不占新的份額，只要不超過「該批遺失 − 該批已尋回」；之後入倉照樣增加實體在庫，但不再退款。
 * 2. 寫退回明細（只在這案還沒有明細時）、3. 批次進度改為 `returned`（遺失優先；優先於之後才到的送達、失敗、再次配送回報，見 `shipments/events.ts`）。
 *    登記不動庫存與款項；已交運的數量維持已交運，不從同單補寄，再購須重新下單。
 * 4. 通知顧客商品退回物流中，與登記同一個 batch。
 * 同鍵同內容重送回 `replayed: true`；同鍵不同內容回 `return_key_conflict`。
 */
export async function declareShipmentReturn(
  d1: D1Database,
  db: DrizzleD1Database,
  request: DeclareShipmentReturnInput,
  actor: string,
  now: number,
): Promise<DeclareShipmentReturnResult> {
  const { shipmentId, returnKey, note } = request;
  const items = [...request.items].sort((a, b) => a.orderLineId - b.orderLineId);

  const [shipment] = await db.select({ id: shipments.id }).from(shipments).where(eq(shipments.id, shipmentId));
  if (!shipment) return fail("shipment_not_found");

  const requestHash = await hashCaseRequest(items, note);
  const itemsJson = JSON.stringify(items);
  const returnId = sql`(SELECT id FROM shipment_returns WHERE shipment_id = ${shipmentId} AND return_key = ${returnKey})`;

  const results = await batchAtEffectiveNow(d1, now, [
    sql`
      INSERT INTO shipment_returns (order_id, shipment_id, return_key, request_hash, status, note, declared_at, actor)
      SELECT ship.order_id, ship.id, ${returnKey}, ${requestHash}, 'returning', ${note}, ${effectiveNow}, ${actor}
      FROM shipments ship
      WHERE ship.id = ${shipmentId} AND ship.delivery_status <> 'delivered' AND ship.delivered_at IS NULL AND ${returnId} IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM json_each(${itemsJson}) item
          LEFT JOIN shipment_items ship_item ON ship_item.shipment_id = ship.id AND ship_item.order_line_id = json_extract(item.value, '$.orderLineId')
          WHERE ship_item.id IS NULL
            OR ${lostInBatchQuantity(sql`ship_item.order_line_id`, sql`ship.id`)} + ${heldByReturnBatchQuantity(sql`ship_item.order_line_id`, sql`ship.id`)} + ${returnedInBatchQuantity(sql`ship_item.order_line_id`, sql`ship.id`)} + json_extract(item.value, '$.quantity') > ship_item.quantity
            OR ${lostQuantity(sql`ship_item.order_line_id`)} + ${heldByReturnQuantity(sql`ship_item.order_line_id`)} + ${heldByShipmentReturnQuantity(sql`ship_item.order_line_id`)} + json_extract(item.value, '$.quantity') > ${dispatchedQuantity(sql`ship_item.order_line_id`)}
            OR ${foundLostInBatchQuantity(sql`ship_item.order_line_id`, sql`ship.id`)} + json_extract(item.value, '$.foundLostQuantity') > ${lostInBatchQuantity(sql`ship_item.order_line_id`, sql`ship.id`)}
        )
      ON CONFLICT (shipment_id, return_key) DO NOTHING
    `,
    sql`
      INSERT INTO shipment_return_items (return_id, order_line_id, quantity, found_lost_quantity)
      SELECT ${returnId}, json_extract(item.value, '$.orderLineId'), json_extract(item.value, '$.quantity'), json_extract(item.value, '$.foundLostQuantity')
      FROM json_each(${itemsJson}) item
      WHERE ${returnId} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM shipment_return_items WHERE return_id = ${returnId})
    `,
    sql`UPDATE shipments SET delivery_status = 'returned' WHERE id = ${shipmentId} AND ${returnId} IS NOT NULL AND delivery_status NOT IN ('lost', 'returned')`,
    insertShipmentReturnDeclaredNotice(returnId),
    sql`SELECT id, request_hash AS requestHash FROM shipment_returns WHERE shipment_id = ${shipmentId} AND return_key = ${returnKey}`,
  ]);

  const created = results[0]!.meta.changes > 0;
  const found = results[results.length - 1]!.results[0] as { id: number; requestHash: string } | undefined;
  if (!found) {
    // 寫入被擋下：已送達、明細不在這一批，或數量被占用（全部由上面那句條件寫入判斷，這裡只讀出原因）
    const [current] = await db.select({ deliveryStatus: shipments.deliveryStatus, deliveredAt: shipments.deliveredAt }).from(shipments).where(eq(shipments.id, shipmentId));
    if (current?.deliveryStatus === "delivered" || (current?.deliveredAt ?? null) !== null) return fail("shipment_delivered");
    const inBatch = new Set((await db.select({ orderLineId: shipmentItems.orderLineId }).from(shipmentItems).where(eq(shipmentItems.shipmentId, shipmentId))).map((row) => row.orderLineId));
    return fail(items.some((item) => !inBatch.has(item.orderLineId)) ? "return_line_invalid" : "return_quantity_exceeded");
  }
  if (!created && found.requestHash !== requestHash) return fail("return_key_conflict");
  return ok({ returnId: found.id, replayed: !created });
}
