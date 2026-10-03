import { eq, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { batchAtEffectiveNow, effectiveNow } from "../shared/high-water-mark";
import { fail, ok } from "../shared/result";
import { receiveIntoStock, type StockReturnCase } from "../stock/conversion";
import type { RecordShipmentReturnReceiptInput } from "./input";
import { shipmentReturnItems, shipmentReturns, type ShipmentReturnStatus } from "./schema";

export type RecordShipmentReturnReceiptFailure = "shipment_return_not_found" | "shipment_return_wrong_state" | "shipment_return_item_invalid";

export type RecordShipmentReturnReceiptResult =
  | { ok: true; data: { returnId: number; status: Extract<ShipmentReturnStatus, "received" | "not_received">; replayed: boolean } }
  | { ok: false; reason: RecordShipmentReturnReceiptFailure };

/**
 * 管理員記錄一案物流退回的收回（ADR 0006，與顧客退貨同一套庫存轉換，見 `stock/conversion.ts`）：收到實物才增加實體在庫與不可售（待檢，不可販售）。單一 batch，同成同敗：
 * 1. 退回中 → 已收回（一件都沒收到則為「未收到」結案，不動庫存，占用的數量釋出）；每筆明細都要填實際收到的數量與其中尋回的遺失品數量，各不超過登記的數量。
 * 2. 寫各明細實際收到的數量（只在還沒記錄時）。
 * 3. 實體在庫與不可售各加收到的總數（含尋回的遺失品）、4. 寫庫存流水 `shipment_return_received`：只在這案還沒有收回流水時執行，所以同內容重送不會重複入庫。
 * 收回只記實物，不動款項；款項在檢查完成時登記（`shipment-returns/inspect.ts`）。未收到的尋回遺失品仍算遺失，之後還可以再登記尋回。
 * 狀態不是退回中（且不是同內容的重送）回 `shipment_return_wrong_state`，明細與登記對不上或超過登記數量回 `shipment_return_item_invalid`。
 */
export async function recordShipmentReturnReceipt(
  d1: D1Database,
  db: DrizzleD1Database,
  request: RecordShipmentReturnReceiptInput & { actor: string },
  now: number,
): Promise<RecordShipmentReturnReceiptResult> {
  const { returnId, items, note, actor } = request;

  const [found] = await db.select({ status: shipmentReturns.status }).from(shipmentReturns).where(eq(shipmentReturns.id, returnId));
  if (!found) return fail("shipment_return_not_found");
  const recorded = await selectRecorded(db, returnId);
  const inputOf = (orderLineId: number) => items.find((item) => item.orderLineId === orderLineId);
  const sameLines = recorded.length === items.length && recorded.every((row) => inputOf(row.orderLineId) !== undefined);
  if (!sameLines || recorded.some((row) => inputOf(row.orderLineId)!.receivedQuantity > row.quantity || inputOf(row.orderLineId)!.receivedFoundLostQuantity > row.foundLostQuantity)) return fail("shipment_return_item_invalid");

  // 已記錄過：同內容重送冪等，內容不同代表已經記錄過別的結果
  if (found.status === "received" || found.status === "not_received" || found.status === "completed") {
    return found.status !== "completed" && matchesRecorded(recorded, items) ? ok({ returnId, status: found.status, replayed: true }) : fail("shipment_return_wrong_state");
  }

  const received = items.reduce((sum, item) => sum + item.receivedQuantity + item.receivedFoundLostQuantity, 0);
  const target = received > 0 ? "received" : "not_received";
  const itemsJson = JSON.stringify(items);
  const reason = `物流退回收回入倉（物流退回 #${returnId}）`;
  const receivedByVariant = sql`
    SELECT line.variant_id AS variant_id, SUM(item.received_quantity + item.received_found_lost_quantity) AS quantity
    FROM shipment_return_items item JOIN order_lines line ON line.id = item.order_line_id
    WHERE item.return_id = ${returnId} AND item.received_quantity + item.received_found_lost_quantity > 0
    GROUP BY line.variant_id`;
  const stockCase: StockReturnCase = {
    movementColumn: "shipment_return_id",
    receivedKind: "shipment_return_received",
    inspectedKind: "shipment_return_inspected",
    caseId: returnId,
    orderId: sql`(SELECT order_id FROM shipment_returns WHERE id = ${returnId})`,
    receivedByVariant,
    sellableByVariant: receivedByVariant,
    isReceived: sql`EXISTS (SELECT 1 FROM shipment_returns WHERE id = ${returnId} AND status = 'received')`,
    isCompleted: sql`EXISTS (SELECT 1 FROM shipment_returns WHERE id = ${returnId} AND status = 'completed')`,
  };

  const results = await batchAtEffectiveNow(d1, now, [
    sql`
      UPDATE shipment_returns
      SET status = ${target}, received_at = ${effectiveNow}, received_by = ${actor}, receipt_note = ${note}
      WHERE id = ${returnId} AND status = 'returning'
    `,
    sql`
      UPDATE shipment_return_items
      SET received_quantity = (SELECT json_extract(item.value, '$.receivedQuantity') FROM json_each(${itemsJson}) item WHERE json_extract(item.value, '$.orderLineId') = shipment_return_items.order_line_id),
        received_found_lost_quantity = (SELECT json_extract(item.value, '$.receivedFoundLostQuantity') FROM json_each(${itemsJson}) item WHERE json_extract(item.value, '$.orderLineId') = shipment_return_items.order_line_id)
      WHERE return_id = ${returnId} AND received_quantity IS NULL
        AND EXISTS (SELECT 1 FROM shipment_returns WHERE id = ${returnId} AND status IN ('received', 'not_received'))
    `,
    ...receiveIntoStock(stockCase, actor, reason),
  ]);

  if (results[0]!.meta.changes > 0) return ok({ returnId, status: target, replayed: false });
  // 讀到退回中之後被別人搶先處理：重新讀結果，同內容視為重送，其餘是狀態不符
  const [current] = await db.select({ status: shipmentReturns.status }).from(shipmentReturns).where(eq(shipmentReturns.id, returnId));
  if (current && (current.status === "received" || current.status === "not_received") && matchesRecorded(await selectRecorded(db, returnId), items)) return ok({ returnId, status: current.status, replayed: true });
  return fail("shipment_return_wrong_state");
}

function selectRecorded(db: DrizzleD1Database, returnId: number) {
  return db
    .select({ orderLineId: shipmentReturnItems.orderLineId, quantity: shipmentReturnItems.quantity, foundLostQuantity: shipmentReturnItems.foundLostQuantity, receivedQuantity: shipmentReturnItems.receivedQuantity, receivedFoundLostQuantity: shipmentReturnItems.receivedFoundLostQuantity })
    .from(shipmentReturnItems)
    .where(eq(shipmentReturnItems.returnId, returnId));
}

const matchesRecorded = (recorded: { orderLineId: number; receivedQuantity: number | null; receivedFoundLostQuantity: number | null }[], items: RecordShipmentReturnReceiptInput["items"]) =>
  recorded.every((row) => {
    const item = items.find((entry) => entry.orderLineId === row.orderLineId);
    return row.receivedQuantity === item?.receivedQuantity && row.receivedFoundLostQuantity === item?.receivedFoundLostQuantity;
  });
