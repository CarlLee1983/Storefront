import { and, eq, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { dispatchedQuantity } from "../shipments/queries";
import { batchAtEffectiveNow, effectiveNow } from "../shared/high-water-mark";
import { fail, ok } from "../shared/result";
import { orderLines, orders, PAID, PARTIALLY_SHIPPED, type OrderStatus } from "../orders/schema";
import { heldByCancellationQuantity } from "./queries";
import { cancellationRequests } from "./schema";
import type { RequestCancellationInput } from "./input";

/** 可以申請取消的訂單狀態：已付款、尚有未交運數量。已出貨的數量走退貨流程，待付款只能整單取消。 */
const CANCELLABLE_STATUSES: readonly OrderStatus[] = [PAID, PARTIALLY_SHIPPED];

export type CancellationRequestFailure =
  | "order_not_found"
  | "order_not_cancellable"
  | "cancellation_line_invalid"
  | "cancellation_quantity_exceeded"
  | "request_key_conflict";

export type CancellationRequestResult =
  | { ok: true; data: { requestId: number; replayed: boolean } }
  | { ok: false; reason: CancellationRequestFailure };

/**
 * 顧客申請取消已付款未交運的指定數量（ADR 0007）；單一 batch，申請與明細同成同敗：
 * 1. 建立申請：訂單屬於這位顧客且此刻是已付款或部分出貨、同一冪等鍵還沒有申請，且每筆明細「已交運 + 被申請占用（待審與核准）+ 本次」不超過明細數量。
 *    占用數量與交運共用同一個條件（見 `shipments/dispatch.ts`），所以申請與交運並行時以 batch 的落地順序為準：
 *    申請先成立，該數量立刻不可交運（仍占已付款保留）；交運先成立，這些數量已不是可取消的未交運數量，申請被擋下（走退貨）。
 *    同一明細重複申請同樣被占用數量擋下，不會重複取消。
 * 2. 寫申請明細：只在這個申請還沒有明細時，同鍵重送不會重複寫。
 * 結果不以受影響列數判斷，而是 batch 之後讀這個冪等鍵的申請：存在就成功（`replayed` 表示不是這次建立的），同鍵不同內容回 `request_key_conflict`。
 */
export async function requestCancellation(
  d1: D1Database,
  db: DrizzleD1Database,
  customerId: string,
  request: RequestCancellationInput,
  now: number,
): Promise<CancellationRequestResult> {
  const { orderId, requestKey, items, reason } = request;

  const [order] = await db.select({ status: orders.status }).from(orders).where(and(eq(orders.id, orderId), eq(orders.customerId, customerId)));
  if (!order) return fail("order_not_found");
  // 已有該鍵的申請時，訂單之後轉成別的狀態（例如全部核准後已取消）仍回原申請，所以只在沒有該鍵時擋狀態
  const [existing] = await db.select({ id: cancellationRequests.id }).from(cancellationRequests).where(and(eq(cancellationRequests.orderId, orderId), eq(cancellationRequests.requestKey, requestKey)));
  if (!existing && !CANCELLABLE_STATUSES.includes(order.status)) return fail("order_not_cancellable");

  const lineIds = new Set((await db.select({ id: orderLines.id }).from(orderLines).where(eq(orderLines.orderId, orderId))).map((line) => line.id));
  if (items.some((item) => !lineIds.has(item.orderLineId))) return fail("cancellation_line_invalid");

  const requestHash = await hashRequest(items, reason);
  const itemsJson = JSON.stringify(items);
  const requestId = sql`(SELECT id FROM cancellation_requests WHERE order_id = ${orderId} AND request_key = ${requestKey})`;

  const results = await batchAtEffectiveNow(d1, now, [
    sql`
      INSERT INTO cancellation_requests (order_id, request_key, request_hash, status, reason, requested_at)
      SELECT orders.id, ${requestKey}, ${requestHash}, 'pending', ${reason}, ${effectiveNow}
      FROM orders
      WHERE orders.id = ${orderId} AND orders.customer_id = ${customerId} AND orders.status IN (${sql.join(CANCELLABLE_STATUSES.map((status) => sql`${status}`), sql`, `)})
        AND ${requestId} IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM json_each(${itemsJson}) item
          LEFT JOIN order_lines line ON line.id = json_extract(item.value, '$.orderLineId') AND line.order_id = orders.id
          WHERE line.id IS NULL
            OR ${dispatchedQuantity(sql`line.id`)} + ${heldByCancellationQuantity(sql`line.id`)} + json_extract(item.value, '$.quantity') > line.quantity
        )
    `,
    sql`
      INSERT INTO cancellation_request_items (request_id, order_line_id, quantity)
      SELECT ${requestId}, json_extract(item.value, '$.orderLineId'), json_extract(item.value, '$.quantity')
      FROM json_each(${itemsJson}) item
      WHERE ${requestId} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM cancellation_request_items WHERE request_id = ${requestId})
    `,
    sql`SELECT id, request_hash AS requestHash FROM cancellation_requests WHERE order_id = ${orderId} AND request_key = ${requestKey}`,
  ]);

  const created = results[0]!.meta.changes > 0;
  const found = results[results.length - 1]!.results[0] as { id: number; requestHash: string } | undefined;
  if (found && !created && found.requestHash !== requestHash) return fail("request_key_conflict");
  if (found) return ok({ requestId: found.id, replayed: !created });

  const [current] = await db.select({ status: orders.status }).from(orders).where(eq(orders.id, orderId));
  return fail(current && CANCELLABLE_STATUSES.includes(current.status) ? "cancellation_quantity_exceeded" : "order_not_cancellable");
}

/** 申請內容的 SHA-256 hex（明細依訂單明細編號排序，同樣內容得到同樣指紋）。 */
async function hashRequest(items: RequestCancellationInput["items"], reason: string): Promise<string> {
  const normalized = JSON.stringify({ items: [...items].sort((a, b) => a.orderLineId - b.orderLineId), reason });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
