import { eq, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { batchAtEffectiveNow, effectiveNow } from "../shared/high-water-mark";
import { fail, ok } from "../shared/result";
import { receiveIntoStock, type StockReturnCase } from "../stock/conversion";
import type { RecordReturnReceiptInput } from "./input";
import { returnRequestItems, returnRequests, type ReturnStatus } from "./schema";

export type RecordReceiptFailure = "return_not_found" | "return_wrong_state" | "return_item_invalid";

export type RecordReceiptResult =
  | { ok: true; data: { requestId: number; status: Extract<ReturnStatus, "received" | "not_received">; replayed: boolean } }
  | { ok: false; reason: RecordReceiptFailure };

/**
 * 管理員記錄一案退貨的收回（ADR 0006）：收到實物才增加實體在庫與不可售（待檢，不可販售）。單一 batch，同成同敗：
 * 1. 已核准 → 已收回（一件都沒收到則為「未收到」結案，不動庫存，占用的數量釋出）；每筆申請明細都要填實際收到的數量，不超過申請數量。
 * 2. 寫各明細實際收到的數量（只在還沒記錄時）。
 * 3. 實體在庫與不可售各加收到的數量、4. 寫庫存流水 `return_received`：只在這案還沒有收回流水時執行，所以同內容重送不會重複入庫。
 *    入庫在寫流水之前，流水的 `on_hand_after` 直接讀入庫後的數字。
 * 收回只記實物，不動款項；款項在檢查完成時登記（`returns/inspect.ts`）。
 * 狀態不是已核准（且不是同內容的重送）回 `return_wrong_state`，明細與申請對不上或超過申請數量回 `return_item_invalid`。
 */
export async function recordReturnReceipt(
  d1: D1Database,
  db: DrizzleD1Database,
  request: RecordReturnReceiptInput & { actor: string },
  now: number,
): Promise<RecordReceiptResult> {
  const { requestId, items, note, actor } = request;

  const [found] = await db.select({ status: returnRequests.status }).from(returnRequests).where(eq(returnRequests.id, requestId));
  if (!found) return fail("return_not_found");
  const recorded = await selectRecorded(db, requestId);
  const sameLines = recorded.length === items.length && recorded.every((row) => items.some((item) => item.orderLineId === row.orderLineId));
  if (!sameLines || recorded.some((row) => items.find((item) => item.orderLineId === row.orderLineId)!.receivedQuantity > row.quantity)) return fail("return_item_invalid");

  // 已記錄過：同內容重送冪等，內容不同代表已經記錄過別的結果
  if (found.status === "received" || found.status === "not_received") return matchesRecorded(recorded, items) ? ok({ requestId, status: found.status, replayed: true }) : fail("return_wrong_state");
  if (found.status !== "approved") return fail("return_wrong_state");

  const received = items.reduce((sum, item) => sum + item.receivedQuantity, 0);
  const target = received > 0 ? "received" : "not_received";
  const itemsJson = JSON.stringify(items);
  const reason = `退貨收回入倉（退貨申請 #${requestId}）`;
  const receivedByVariant = sql`
    SELECT line.variant_id AS variant_id, SUM(item.received_quantity) AS quantity
    FROM return_request_items item JOIN order_lines line ON line.id = item.order_line_id
    WHERE item.request_id = ${requestId} AND item.received_quantity > 0
    GROUP BY line.variant_id`;
  const stockCase: StockReturnCase = {
    movementColumn: "return_request_id",
    receivedKind: "return_received",
    inspectedKind: "return_inspected",
    caseId: requestId,
    orderId: sql`(SELECT order_id FROM return_requests WHERE id = ${requestId})`,
    receivedByVariant,
    sellableByVariant: receivedByVariant,
    isReceived: sql`EXISTS (SELECT 1 FROM return_requests WHERE id = ${requestId} AND status = 'received')`,
    isCompleted: sql`EXISTS (SELECT 1 FROM return_requests WHERE id = ${requestId} AND status = 'completed')`,
  };

  const results = await batchAtEffectiveNow(d1, now, [
    sql`
      UPDATE return_requests
      SET status = ${target}, received_at = ${effectiveNow}, received_by = ${actor}, receipt_note = ${note}
      WHERE id = ${requestId} AND status = 'approved'
    `,
    sql`
      UPDATE return_request_items
      SET received_quantity = (SELECT json_extract(item.value, '$.receivedQuantity') FROM json_each(${itemsJson}) item WHERE json_extract(item.value, '$.orderLineId') = return_request_items.order_line_id)
      WHERE request_id = ${requestId} AND received_quantity IS NULL
        AND EXISTS (SELECT 1 FROM return_requests WHERE id = ${requestId} AND status IN ('received', 'not_received'))
    `,
    ...receiveIntoStock(stockCase, actor, reason),
  ]);

  if (results[0]!.meta.changes > 0) return ok({ requestId, status: target, replayed: false });
  // 讀到 approved 之後被別人搶先處理：重新讀結果，同內容視為重送，其餘是狀態不符
  const [current] = await db.select({ status: returnRequests.status }).from(returnRequests).where(eq(returnRequests.id, requestId));
  if (current && (current.status === "received" || current.status === "not_received") && matchesRecorded(await selectRecorded(db, requestId), items)) return ok({ requestId, status: current.status, replayed: true });
  return fail("return_wrong_state");
}

function selectRecorded(db: DrizzleD1Database, requestId: number) {
  return db
    .select({ orderLineId: returnRequestItems.orderLineId, quantity: returnRequestItems.quantity, receivedQuantity: returnRequestItems.receivedQuantity })
    .from(returnRequestItems)
    .where(eq(returnRequestItems.requestId, requestId));
}

const matchesRecorded = (recorded: { orderLineId: number; receivedQuantity: number | null }[], items: RecordReturnReceiptInput["items"]) =>
  recorded.every((row) => row.receivedQuantity === items.find((item) => item.orderLineId === row.orderLineId)?.receivedQuantity);
