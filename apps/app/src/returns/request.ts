import { and, eq, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { batchAtEffectiveNow, effectiveNow } from "../shared/high-water-mark";
import { fail, ok } from "../shared/result";
import { dispatchedQuantity } from "../shipments/queries";
import { orderLines, orders, PARTIALLY_SHIPPED, SHIPPED, type OrderStatus } from "../orders/schema";
import { hashCaseRequest } from "../shared/request-hash";
import { heldByReturnQuantity } from "./queries";
import { returnRequests } from "./schema";
import type { RequestReturnInput } from "./input";

/** 可以申請退貨的訂單狀態：已有交運的數量（部分出貨、已出貨）。沒有任何已交運數量的訂單走取消，不走退貨。 */
const RETURNABLE_STATUSES: readonly OrderStatus[] = [PARTIALLY_SHIPPED, SHIPPED];

export type ReturnRequestFailure =
  | "order_not_found"
  | "order_not_returnable"
  | "return_line_invalid"
  | "return_quantity_exceeded"
  | "request_key_conflict";

export type ReturnRequestResult =
  | { ok: true; data: { requestId: number; replayed: boolean } }
  | { ok: false; reason: ReturnRequestFailure };

/**
 * 顧客申請退貨已交運的指定數量（人工受理入口，不依自助退貨期限擋下；期限與送達日顯示由 #118 加上）；單一 batch，申請與明細同成同敗：
 * 1. 建立申請：訂單屬於這位顧客且此刻有已交運的數量、同一冪等鍵還沒有申請，且每筆明細「被退貨占用（待審、核准、已收回、已完成）+ 本次」不超過已交運數量。
 *    占用與數量上限共用 `heldByReturnQuantity`，所以重複申請、並行申請與已退貨的數量都被同一句條件擋下，不會超量。
 *    取消申請只動未交運的數量（`cancellations/request.ts`），與退貨用的是明細數量的兩個互斥部分，不會重複占用。
 * 2. 寫申請明細：只在這個申請還沒有明細時，同鍵重送不會重複寫。
 * 結果不以受影響列數判斷，而是 batch 之後讀這個冪等鍵的申請：存在就成功（`replayed` 表示不是這次建立的），同鍵不同內容回 `request_key_conflict`。
 */
export async function requestReturn(
  d1: D1Database,
  db: DrizzleD1Database,
  customerId: string,
  request: RequestReturnInput,
  now: number,
): Promise<ReturnRequestResult> {
  const { orderId, requestKey, items, reason } = request;

  const [order] = await db.select({ status: orders.status }).from(orders).where(and(eq(orders.id, orderId), eq(orders.customerId, customerId)));
  if (!order) return fail("order_not_found");
  // 已有該鍵的申請時，訂單之後的狀態不影響回原申請，所以只在沒有該鍵時擋狀態
  const [existing] = await db.select({ id: returnRequests.id }).from(returnRequests).where(and(eq(returnRequests.orderId, orderId), eq(returnRequests.requestKey, requestKey)));
  if (!existing && !RETURNABLE_STATUSES.includes(order.status)) return fail("order_not_returnable");

  const lineIds = new Set((await db.select({ id: orderLines.id }).from(orderLines).where(eq(orderLines.orderId, orderId))).map((line) => line.id));
  if (items.some((item) => !lineIds.has(item.orderLineId))) return fail("return_line_invalid");

  const requestHash = await hashCaseRequest(items, reason);
  const itemsJson = JSON.stringify(items);
  const requestId = sql`(SELECT id FROM return_requests WHERE order_id = ${orderId} AND request_key = ${requestKey})`;

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
    `,
    sql`
      INSERT INTO return_request_items (request_id, order_line_id, quantity)
      SELECT ${requestId}, json_extract(item.value, '$.orderLineId'), json_extract(item.value, '$.quantity')
      FROM json_each(${itemsJson}) item
      WHERE ${requestId} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM return_request_items WHERE request_id = ${requestId})
    `,
    sql`SELECT id, request_hash AS requestHash FROM return_requests WHERE order_id = ${orderId} AND request_key = ${requestKey}`,
  ]);

  const created = results[0]!.meta.changes > 0;
  const found = results[results.length - 1]!.results[0] as { id: number; requestHash: string } | undefined;
  if (found && !created && found.requestHash !== requestHash) return fail("request_key_conflict");
  if (found) return ok({ requestId: found.id, replayed: !created });

  const [current] = await db.select({ status: orders.status }).from(orders).where(eq(orders.id, orderId));
  return fail(current && RETURNABLE_STATUSES.includes(current.status) ? "return_quantity_exceeded" : "order_not_returnable");
}
