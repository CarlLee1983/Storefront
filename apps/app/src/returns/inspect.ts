import { eq, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { insertReturnCompletedNotice } from "../contact/notices";
import { RETURN_CASE, shippingRefundSql } from "../payments/exit-refund";
import { newGatewayRefundId, withinQuotaSql } from "../payments/refunds";
import type { RefundStatus } from "../payments/shared";
import { batchAtEffectiveNow, effectiveNow } from "../shared/high-water-mark";
import { fail, ok } from "../shared/result";
import type { RecordReturnInspectionInput } from "./input";
import { returnRequestItems, returnRequests } from "./schema";

export type RecordInspectionFailure = "return_not_found" | "return_wrong_state" | "return_item_invalid";

export type RecordInspectionResult =
  | {
      ok: true;
      data: {
        requestId: number;
        /** 這次呼叫不是第一次記錄檢查結果（重送）。 */
        replayed: boolean;
        /** 檢查完成後登記的退款；額度不足而尚未登記為 null（重送會再嘗試登記）。 */
        refund: { id: number; status: RefundStatus } | null;
      };
    }
  | { ok: false; reason: RecordInspectionFailure };

/**
 * 管理員記錄一案退貨的檢查結果（ADR 0006、0007）：每筆有收到的明細填良品與損壞品數量，兩者相加等於實際收到的數量。單一 batch，同成同敗：
 * 1. 已收回 → 已完成，同一句算定退款拆分：商品款 = 各明細實際收到數量 × 原實付單價（良品與損壞品都退，收回運費由商家負擔），
 *    運費依 `shippingRefundSql`（同類全數退出才退一次，含取消的數量；見 `payments/exit-refund.ts`）。
 * 2. 寫各明細的良品與損壞數量（只在還沒記錄時；沒填的明細沒收到東西，記為 0）。
 * 3. 不可售減去良品數量、4. 寫庫存流水 `return_inspected`（在庫不變，良品轉可售）：只在這案還沒有檢查流水時執行，重送不會重複轉換。
 *    損壞品留在不可售，直到管理員報廢（`stock/scrap.ts`）；檢查不寫入退款以外的款項事實。
 * 5. 登記這案的退款（唯一索引保證一案一筆）：額度條件與其他退款共用 `withinQuotaSql`，綁定讓訂單成立的那筆付款；
 *    登記在同一個 batch，所以不會有「檢查完了卻漏開退款」的空窗；額度不足時檢查結果照樣成立（退款是否成功不反轉已發生的實物事件），重送會再嘗試登記。
 * 6. 完成通知。退款的執行（向閘道送出）在 batch 之外，由呼叫端接續。
 * 同內容重送回 `replayed: true`；內容與已記錄的不同或狀態不是已收回回 `return_wrong_state`，明細對不上或數量加不起來回 `return_item_invalid`。
 */
export async function recordReturnInspection(
  d1: D1Database,
  db: DrizzleD1Database,
  request: RecordReturnInspectionInput & { actor: string },
  now: number,
): Promise<RecordInspectionResult> {
  const { requestId, items, note, actor } = request;

  const [found] = await db.select({ status: returnRequests.status }).from(returnRequests).where(eq(returnRequests.id, requestId));
  if (!found) return fail("return_not_found");
  if (found.status !== "received" && found.status !== "completed") return fail("return_wrong_state");
  const recorded = await db
    .select({ orderLineId: returnRequestItems.orderLineId, receivedQuantity: returnRequestItems.receivedQuantity, sellableQuantity: returnRequestItems.sellableQuantity, damagedQuantity: returnRequestItems.damagedQuantity })
    .from(returnRequestItems)
    .where(eq(returnRequestItems.requestId, requestId));

  const inputOf = (orderLineId: number) => items.find((item) => item.orderLineId === orderLineId);
  if (items.some((item) => !recorded.some((row) => row.orderLineId === item.orderLineId))) return fail("return_item_invalid");
  if (recorded.some((row) => (inputOf(row.orderLineId)?.sellableQuantity ?? 0) + (inputOf(row.orderLineId)?.damagedQuantity ?? 0) !== (row.receivedQuantity ?? 0))) {
    // 已完成的案件重送不同的數字，是與已記錄的結果衝突；其餘是數量加不起來
    return fail(found.status === "completed" ? "return_wrong_state" : "return_item_invalid");
  }
  if (found.status === "completed" && !recorded.every((row) => row.sellableQuantity === (inputOf(row.orderLineId)?.sellableQuantity ?? 0))) return fail("return_wrong_state");

  const itemsJson = JSON.stringify(items);
  const reason = `退貨檢查合格轉可售（退貨申請 #${requestId}）`;
  const notYetConverted = sql`NOT EXISTS (SELECT 1 FROM stock_movements WHERE return_request_id = ${requestId} AND kind = 'return_inspected')`;
  const completed = sql`EXISTS (SELECT 1 FROM return_requests WHERE id = ${requestId} AND status = 'completed')`;
  const sellableByVariant = sql`
    SELECT line.variant_id AS variant_id, SUM(item.sellable_quantity) AS quantity
    FROM return_request_items item JOIN order_lines line ON line.id = item.order_line_id
    WHERE item.request_id = ${requestId} AND item.sellable_quantity > 0
    GROUP BY line.variant_id`;

  const results = await batchAtEffectiveNow(d1, now, [
    sql`
      UPDATE return_requests
      SET status = 'completed', inspected_at = ${effectiveNow}, inspected_by = ${actor}, inspection_note = ${note},
        goods_twd = (
          SELECT COALESCE(SUM(item.received_quantity * line.unit_price_twd), 0)
          FROM return_request_items item JOIN order_lines line ON line.id = item.order_line_id
          WHERE item.request_id = return_requests.id
        ),
        standard_shipping_twd = ${shippingRefundSql(RETURN_CASE, "standard", "standard_shipping_fee_twd", "standard_shipping_twd")},
        large_shipping_twd = ${shippingRefundSql(RETURN_CASE, "large", "large_shipping_fee_twd", "large_shipping_twd")}
      WHERE id = ${requestId} AND status = 'received'
    `,
    sql`
      UPDATE return_request_items
      SET sellable_quantity = COALESCE((SELECT json_extract(item.value, '$.sellableQuantity') FROM json_each(${itemsJson}) item WHERE json_extract(item.value, '$.orderLineId') = return_request_items.order_line_id), 0),
        damaged_quantity = COALESCE((SELECT json_extract(item.value, '$.damagedQuantity') FROM json_each(${itemsJson}) item WHERE json_extract(item.value, '$.orderLineId') = return_request_items.order_line_id), 0)
      WHERE request_id = ${requestId} AND sellable_quantity IS NULL AND ${completed}
    `,
    sql`
      UPDATE product_variants
      SET unavailable = unavailable - (SELECT sellable.quantity FROM (${sellableByVariant}) sellable WHERE sellable.variant_id = product_variants.id)
      WHERE id IN (SELECT variant_id FROM (${sellableByVariant})) AND ${completed} AND ${notYetConverted}
    `,
    sql`
      INSERT INTO stock_movements (variant_id, kind, delta, on_hand_after, unavailable_delta, unavailable_after, order_id, return_request_id, actor, reason, created_at)
      SELECT variant.id, 'return_inspected', 0, variant.on_hand, -sellable.quantity, variant.unavailable,
        (SELECT order_id FROM return_requests WHERE id = ${requestId}), ${requestId}, ${actor}, ${reason}, ${effectiveNow}
      FROM (${sellableByVariant}) sellable JOIN product_variants variant ON variant.id = sellable.variant_id
      WHERE ${completed} AND ${notYetConverted}
    `,
    sql`
      INSERT INTO refunds (order_id, payment_id, reason, gateway_refund_id, amount_twd, goods_twd, shipping_twd, status, return_request_id, created_at)
      SELECT rr.order_id, p.id, 'return', ${newGatewayRefundId()},
        rr.goods_twd + rr.standard_shipping_twd + rr.large_shipping_twd, rr.goods_twd, rr.standard_shipping_twd + rr.large_shipping_twd,
        'pending', rr.id, ${effectiveNow}
      FROM return_requests rr
      JOIN orders o ON o.id = rr.order_id
      JOIN payments p ON p.id = o.paid_by_payment_id
      WHERE rr.id = ${requestId} AND rr.status = 'completed'
        AND rr.goods_twd + rr.standard_shipping_twd + rr.large_shipping_twd > 0
        AND ${withinQuotaSql(sql`(rr.goods_twd + rr.standard_shipping_twd + rr.large_shipping_twd)`)}
      ON CONFLICT (return_request_id) DO NOTHING
    `,
    insertReturnCompletedNotice(requestId),
    sql`
      SELECT rr.status AS status, refund.id AS refundId, refund.status AS refundStatus
      FROM return_requests rr LEFT JOIN refunds refund ON refund.return_request_id = rr.id
      WHERE rr.id = ${requestId}
    `,
  ]);

  const changed = results[0]!.meta.changes > 0;
  const row = results[results.length - 1]!.results[0] as { status: string; refundId: number | null; refundStatus: RefundStatus | null } | undefined;
  if (!row || row.status !== "completed") return fail("return_wrong_state");
  // 讀到已收回之後被別人搶先記錄：只有確認內容相同才算重送，這裡 batch 內的明細寫入已被擋下，所以重新比對
  if (!changed && found.status === "received") {
    const latest = await db.select({ orderLineId: returnRequestItems.orderLineId, sellableQuantity: returnRequestItems.sellableQuantity }).from(returnRequestItems).where(eq(returnRequestItems.requestId, requestId));
    if (!latest.every((rowItem) => rowItem.sellableQuantity === (inputOf(rowItem.orderLineId)?.sellableQuantity ?? 0))) return fail("return_wrong_state");
  }
  return ok({ requestId, replayed: !changed, refund: row.refundId === null ? null : { id: row.refundId, status: row.refundStatus! } });
}
