import { and, eq, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { batchAtEffectiveNow, effectiveNow, readEffectiveNow } from "../shared/high-water-mark";
import { fail, ok } from "../shared/result";
import { dispatchedQuantity } from "../shipments/queries";
import { orderLines, orders, PARTIALLY_SHIPPED, SHIPPED, type OrderStatus } from "../orders/schema";
import { shipmentItems, shipments } from "../shipments/schema";
import { hashCaseRequest } from "../shared/request-hash";
import { heldByReturnBatchQuantity, heldByReturnQuantity } from "./queries";
import { returnRequests } from "./schema";
import type { RequestReturnInput } from "./input";
import { returnWindowEndSql, returnWindowState } from "./window";

/** 可以申請退貨的訂單狀態：已有交運的數量（部分出貨、已出貨）。沒有任何已交運數量的訂單走取消，不走退貨。 */
const RETURNABLE_STATUSES: readonly OrderStatus[] = [PARTIALLY_SHIPPED, SHIPPED];

export type ReturnRequestFailure =
  | "order_not_found"
  | "order_not_returnable"
  | "return_line_invalid"
  | "return_quantity_exceeded"
  | "return_batch_invalid"
  | "shipment_not_delivered"
  | "return_window_closed"
  | "request_key_conflict";

export type ReturnRequestResult =
  | { ok: true; data: { requestId: number; replayed: boolean } }
  | { ok: false; reason: ReturnRequestFailure };

/**
 * 顧客申請退貨已交運的指定數量；單一 batch，申請與明細同成同敗。兩種入口：
 * - 人工受理（明細不帶 `shipmentId`）：不依自助期限擋下，逾期、送達日未知或瑕疵需求都走這裡。
 * - 自助（明細帶 `shipmentId`，逐批）：該批須屬於這張訂單、含這筆明細、已送達且仍在自助窗口內（`returns/window.ts`，台北日曆日），
 *   且「該批數量 − 該批已被自助占用」足夠；批次判斷與下面的明細層條件在同一句 INSERT 裡，所以窗口、占用與並行都以寫入當下為準。
 *   送達時間之後被較早的回報改寫，只影響之後的申請；已成立的申請不受影響，同鍵重送也回原申請。
 * 1. 建立申請：訂單屬於這位顧客且此刻有已交運的數量、同一冪等鍵還沒有申請，且每筆明細「被退貨占用（待審、核准、已收回、已完成）+ 本次」不超過已交運數量。
 *    占用與數量上限共用 `heldByReturnQuantity`，所以重複申請、並行申請與已退貨的數量都被同一句條件擋下，不會超量。
 *    取消申請只動未交運的數量（`cancellations/request.ts`），與退貨用的是明細數量的兩個互斥部分，不會重複占用。
 * 2. 寫申請明細（自助另外寫批次對應 `return_request_batches`）：只在這個申請還沒有明細時，同鍵重送不會重複寫。
 * 結果不以受影響列數判斷，而是 batch 之後讀這個冪等鍵的申請：存在就成功（`replayed` 表示不是這次建立的），同鍵不同內容回 `request_key_conflict`。
 */
export async function requestReturn(
  d1: D1Database,
  db: DrizzleD1Database,
  customerId: string,
  request: RequestReturnInput,
  now: number,
): Promise<ReturnRequestResult> {
  const { orderId, requestKey, reason } = request;
  const items = [...request.items].sort((a, b) => a.orderLineId - b.orderLineId || (a.shipmentId ?? 0) - (b.shipmentId ?? 0));
  const batches = items.flatMap((item) => (item.shipmentId === undefined ? [] : [{ orderLineId: item.orderLineId, shipmentId: item.shipmentId, quantity: item.quantity }]));
  const selfService = batches.length > 0;

  const [order] = await db.select({ status: orders.status }).from(orders).where(and(eq(orders.id, orderId), eq(orders.customerId, customerId)));
  if (!order) return fail("order_not_found");
  // 已有該鍵的申請時，訂單之後的狀態不影響回原申請，所以只在沒有該鍵時擋狀態
  const [existing] = await db.select({ id: returnRequests.id }).from(returnRequests).where(and(eq(returnRequests.orderId, orderId), eq(returnRequests.requestKey, requestKey)));
  if (!existing && !RETURNABLE_STATUSES.includes(order.status)) return fail("order_not_returnable");

  const lineIds = new Set((await db.select({ id: orderLines.id }).from(orderLines).where(eq(orderLines.orderId, orderId))).map((line) => line.id));
  if (items.some((item) => !lineIds.has(item.orderLineId))) return fail("return_line_invalid");
  if (selfService && !existing) {
    const blocked = await batchFailure(db, orderId, batches, await readEffectiveNow(db, now));
    if (blocked) return fail(blocked);
  }

  // 明細層：同一明細各批加總成一筆申請數量，占用與上限以明細為單位（批次的上限另外在批次條件裡）
  const lineQuantities = [...items.reduce((sums, item) => sums.set(item.orderLineId, (sums.get(item.orderLineId) ?? 0) + item.quantity), new Map<number, number>())].map(([orderLineId, quantity]) => ({ orderLineId, quantity }));
  const requestHash = await hashCaseRequest(items, reason);
  const itemsJson = JSON.stringify(lineQuantities);
  const batchesJson = JSON.stringify(batches);
  const requestId = sql`(SELECT id FROM return_requests WHERE order_id = ${orderId} AND request_key = ${requestKey})`;
  // 自助：每一批都要屬於這張訂單、含這筆明細、已送達且在窗口內、不超過「該批數量 − 該批已被自助占用」
  const batchCondition = selfService
    ? sql`AND NOT EXISTS (
          SELECT 1 FROM json_each(${batchesJson}) batch
          LEFT JOIN shipments ship ON ship.id = json_extract(batch.value, '$.shipmentId') AND ship.order_id = orders.id
          LEFT JOIN shipment_items ship_item ON ship_item.shipment_id = ship.id AND ship_item.order_line_id = json_extract(batch.value, '$.orderLineId')
          WHERE ship_item.id IS NULL
            OR ship.delivered_at IS NULL OR ship.delivered_at > ${effectiveNow} OR ${effectiveNow} >= ${returnWindowEndSql(sql`ship.delivered_at`)}
            OR ${heldByReturnBatchQuantity(sql`ship_item.order_line_id`, sql`ship.id`)} + json_extract(batch.value, '$.quantity') > ship_item.quantity
        )`
    : sql``;

  const results = await batchAtEffectiveNow(d1, now, [
    sql`
      INSERT INTO return_requests (order_id, request_key, request_hash, status, reason, requested_at)
      SELECT orders.id, ${requestKey}, ${requestHash}, 'pending', ${reason}, ${effectiveNow}
      FROM orders
      WHERE orders.id = ${orderId} AND orders.customer_id = ${customerId} AND orders.status IN (${sql.join(RETURNABLE_STATUSES.map((status) => sql`${status}`), sql`, `)})
        AND ${requestId} IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM json_each(${itemsJson}) item
          LEFT JOIN order_lines line ON line.id = json_extract(item.value, '$.orderLineId') AND line.order_id = orders.id
          WHERE line.id IS NULL
            OR ${heldByReturnQuantity(sql`line.id`)} + json_extract(item.value, '$.quantity') > ${dispatchedQuantity(sql`line.id`)}
        )
        ${batchCondition}
    `,
    sql`
      INSERT INTO return_request_items (request_id, order_line_id, quantity)
      SELECT ${requestId}, json_extract(item.value, '$.orderLineId'), json_extract(item.value, '$.quantity')
      FROM json_each(${itemsJson}) item
      WHERE ${requestId} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM return_request_items WHERE request_id = ${requestId})
    `,
    ...(selfService
      ? [
          sql`
            INSERT INTO return_request_batches (request_id, order_line_id, shipment_id, quantity)
            SELECT ${requestId}, json_extract(batch.value, '$.orderLineId'), json_extract(batch.value, '$.shipmentId'), json_extract(batch.value, '$.quantity')
            FROM json_each(${batchesJson}) batch
            WHERE ${requestId} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM return_request_batches WHERE request_id = ${requestId})
          `,
        ]
      : []),
    sql`SELECT id, request_hash AS requestHash FROM return_requests WHERE order_id = ${orderId} AND request_key = ${requestKey}`,
  ]);

  const created = results[0]!.meta.changes > 0;
  const found = results[results.length - 1]!.results[0] as { id: number; requestHash: string } | undefined;
  if (found && !created && found.requestHash !== requestHash) return fail("request_key_conflict");
  if (found) return ok({ requestId: found.id, replayed: !created });

  const [current] = await db.select({ status: orders.status }).from(orders).where(eq(orders.id, orderId));
  if (!current || !RETURNABLE_STATUSES.includes(current.status)) return fail("order_not_returnable");
  // 寫入被擋下時，窗口可能在這之間關閉（或送達時間被改寫）；其餘是數量被占用
  const blocked = selfService ? await batchFailure(db, orderId, batches, await readEffectiveNow(db, now)) : null;
  return fail(blocked ?? "return_quantity_exceeded");
}

/** 自助申請的批次檢查（不含數量）；`now` 是有效時間（`readEffectiveNow`）。撈本單全部批次明細再比對，避免批次很多時綁定參數超過上限。批次不屬於這張訂單或不含該明細、尚未送達（含沒有可靠送達日）、已過窗口；都沒問題回 null。 */
async function batchFailure(
  db: DrizzleD1Database,
  orderId: number,
  batches: { orderLineId: number; shipmentId: number }[],
  now: number,
): Promise<"return_batch_invalid" | "shipment_not_delivered" | "return_window_closed" | null> {
  const rows = await db
    .select({ shipmentId: shipmentItems.shipmentId, orderLineId: shipmentItems.orderLineId, deliveredAt: shipments.deliveredAt })
    .from(shipmentItems)
    .innerJoin(shipments, eq(shipments.id, shipmentItems.shipmentId))
    .where(eq(shipments.orderId, orderId));
  const found = batches.map((batch) => rows.find((row) => row.shipmentId === batch.shipmentId && row.orderLineId === batch.orderLineId));
  if (found.some((row) => !row)) return "return_batch_invalid";
  const states = found.map((row) => returnWindowState(row!.deliveredAt, now));
  if (states.includes("not_delivered")) return "shipment_not_delivered";
  return states.includes("closed") ? "return_window_closed" : null;
}
