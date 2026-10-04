import { eq, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { insertShipmentReturnCompletedNotice } from "../contact/notices";
import { shipmentReturnShippingRefundSql } from "../payments/exit-refund";
import { newGatewayRefundId, withinQuotaSql } from "../payments/refunds";
import type { RefundStatus } from "../payments/shared";
import { batchAtEffectiveNow, effectiveNow } from "../shared/high-water-mark";
import { fail, ok } from "../shared/result";
import { convertInspectedToSellable, type StockReturnCase } from "../stock/conversion";
import type { RecordShipmentReturnInspectionInput } from "./input";
import { shipmentReturnItems, shipmentReturns } from "./schema";

export type RecordShipmentReturnInspectionFailure = "shipment_return_not_found" | "shipment_return_wrong_state" | "shipment_return_item_invalid";

export type RecordShipmentReturnInspectionResult =
  | {
      ok: true;
      data: {
        returnId: number;
        /** 這次呼叫不是第一次記錄檢查結果（重送）。 */
        replayed: boolean;
        /** 檢查完成後登記的退款；額度不足而尚未登記、或沒有需要退款的金額為 null（重送會再嘗試登記）。 */
        refund: { id: number; status: RefundStatus } | null;
      };
    }
  | { ok: false; reason: RecordShipmentReturnInspectionFailure };

/**
 * 管理員記錄一案物流退回的檢查結果（ADR 0006、0007）：每筆有收到的明細填良品與損壞品數量，兩者相加等於實際收到的數量（含尋回的遺失品）。單一 batch，同成同敗：
 * 1. 已收回 → 已完成，同一句算定退款拆分：商品款 = 各明細實際收到的退回數量 × 原實付單價（良品與損壞品都退；尋回的遺失品先前已退過款，不再退），
 *    運費依 `shipmentReturnShippingRefundSql`（任一該類實際入倉就退該類整類原運費一次，與取消、退貨、遺失、別案物流退回互斥；見 `payments/exit-refund.ts`）。
 * 2. 寫各明細的良品與損壞數量（只在還沒記錄時；沒填的明細沒收到東西，記為 0）。
 * 3. 不可售減去良品數量、4. 寫庫存流水 `shipment_return_inspected`（在庫不變，良品轉可售；與退貨檢查同一套轉換，見 `stock/conversion.ts`）：只在這案還沒有檢查流水時執行，重送不會重複轉換。
 *    損壞品留在不可售，直到管理員報廢（`stock/scrap.ts`）。
 * 5. 登記這案的退款（唯一索引保證一案一筆）：額度條件與其他退款共用 `withinQuotaSql`，綁定讓訂單成立的那筆付款；
 *    登記在同一個 batch，所以不會有「檢查完了卻漏開退款」的空窗；額度不足時檢查結果照樣成立（退款是否成功不反轉已發生的實物事件），重送會再嘗試登記。
 * 6. 完成通知（依有沒有登記退款分文案）。退款的執行（向閘道送出）在 batch 之外，由呼叫端接續。
 * 同內容重送回 `replayed: true`；內容與已記錄的不同或狀態不是已收回回 `shipment_return_wrong_state`，明細對不上或數量加不起來回 `shipment_return_item_invalid`。
 */
export async function recordShipmentReturnInspection(
  d1: D1Database,
  db: DrizzleD1Database,
  request: RecordShipmentReturnInspectionInput & { actor: string },
  now: number,
): Promise<RecordShipmentReturnInspectionResult> {
  const { returnId, items, note, actor } = request;

  const [found] = await db.select({ status: shipmentReturns.status }).from(shipmentReturns).where(eq(shipmentReturns.id, returnId));
  if (!found) return fail("shipment_return_not_found");
  if (found.status !== "received" && found.status !== "completed") return fail("shipment_return_wrong_state");
  const recorded = await db
    .select({ orderLineId: shipmentReturnItems.orderLineId, receivedQuantity: shipmentReturnItems.receivedQuantity, receivedFoundLostQuantity: shipmentReturnItems.receivedFoundLostQuantity, sellableQuantity: shipmentReturnItems.sellableQuantity })
    .from(shipmentReturnItems)
    .where(eq(shipmentReturnItems.returnId, returnId));

  const inputOf = (orderLineId: number) => items.find((item) => item.orderLineId === orderLineId);
  if (items.some((item) => !recorded.some((row) => row.orderLineId === item.orderLineId))) return fail("shipment_return_item_invalid");
  const physical = (row: (typeof recorded)[number]) => (row.receivedQuantity ?? 0) + (row.receivedFoundLostQuantity ?? 0);
  if (recorded.some((row) => (inputOf(row.orderLineId)?.sellableQuantity ?? 0) + (inputOf(row.orderLineId)?.damagedQuantity ?? 0) !== physical(row))) {
    // 已完成的案件重送不同的數字，是與已記錄的結果衝突；其餘是數量加不起來
    return fail(found.status === "completed" ? "shipment_return_wrong_state" : "shipment_return_item_invalid");
  }
  if (found.status === "completed" && !recorded.every((row) => row.sellableQuantity === (inputOf(row.orderLineId)?.sellableQuantity ?? 0))) return fail("shipment_return_wrong_state");

  const itemsJson = JSON.stringify(items);
  const reason = `物流退回檢查合格轉可售（物流退回 #${returnId}）`;
  const completed = sql`EXISTS (SELECT 1 FROM shipment_returns WHERE id = ${returnId} AND status = 'completed')`;
  const sellableByVariant = sql`
    SELECT line.variant_id AS variant_id, SUM(item.sellable_quantity) AS quantity
    FROM shipment_return_items item JOIN order_lines line ON line.id = item.order_line_id
    WHERE item.return_id = ${returnId} AND item.sellable_quantity > 0
    GROUP BY line.variant_id`;
  const stockCase: StockReturnCase = {
    movementColumn: "shipment_return_id",
    receivedKind: "shipment_return_received",
    inspectedKind: "shipment_return_inspected",
    caseId: returnId,
    orderId: sql`(SELECT order_id FROM shipment_returns WHERE id = ${returnId})`,
    receivedByVariant: sellableByVariant,
    sellableByVariant,
    isReceived: sql`EXISTS (SELECT 1 FROM shipment_returns WHERE id = ${returnId} AND status = 'received')`,
    isCompleted: completed,
  };

  const results = await batchAtEffectiveNow(d1, now, [
    sql`
      UPDATE shipment_returns
      SET status = 'completed', inspected_at = ${effectiveNow}, inspected_by = ${actor}, inspection_note = ${note},
        goods_twd = (
          SELECT COALESCE(SUM(item.received_quantity * line.unit_price_twd), 0)
          FROM shipment_return_items item JOIN order_lines line ON line.id = item.order_line_id
          WHERE item.return_id = shipment_returns.id
        ),
        standard_shipping_twd = ${shipmentReturnShippingRefundSql("standard", "standard_shipping_fee_twd", "standard_shipping_twd")},
        large_shipping_twd = ${shipmentReturnShippingRefundSql("large", "large_shipping_fee_twd", "large_shipping_twd")}
      WHERE id = ${returnId} AND status = 'received'
    `,
    sql`
      UPDATE shipment_return_items
      SET sellable_quantity = COALESCE((SELECT json_extract(item.value, '$.sellableQuantity') FROM json_each(${itemsJson}) item WHERE json_extract(item.value, '$.orderLineId') = shipment_return_items.order_line_id), 0),
        damaged_quantity = COALESCE((SELECT json_extract(item.value, '$.damagedQuantity') FROM json_each(${itemsJson}) item WHERE json_extract(item.value, '$.orderLineId') = shipment_return_items.order_line_id), 0)
      WHERE return_id = ${returnId} AND sellable_quantity IS NULL AND ${completed}
    `,
    ...convertInspectedToSellable(stockCase, actor, reason),
    sql`
      INSERT INTO refunds (order_id, payment_id, reason, gateway_refund_id, amount_twd, goods_twd, shipping_twd, status, shipment_return_id, created_at)
      SELECT sr.order_id, p.id, 'shipment_return', ${newGatewayRefundId()},
        sr.goods_twd + sr.standard_shipping_twd + sr.large_shipping_twd, sr.goods_twd, sr.standard_shipping_twd + sr.large_shipping_twd,
        'pending', sr.id, ${effectiveNow}
      FROM shipment_returns sr
      JOIN orders o ON o.id = sr.order_id
      JOIN payments p ON p.id = o.paid_by_payment_id
      WHERE sr.id = ${returnId} AND sr.status = 'completed'
        AND sr.goods_twd + sr.standard_shipping_twd + sr.large_shipping_twd > 0
        AND ${withinQuotaSql(sql`(sr.goods_twd + sr.standard_shipping_twd + sr.large_shipping_twd)`)}
      ON CONFLICT (shipment_return_id) DO NOTHING
    `,
    insertShipmentReturnCompletedNotice(returnId),
    sql`
      SELECT sr.status AS status, refund.id AS refundId, refund.status AS refundStatus
      FROM shipment_returns sr LEFT JOIN refunds refund ON refund.shipment_return_id = sr.id
      WHERE sr.id = ${returnId}
    `,
  ]);

  const changed = results[0]!.meta.changes > 0;
  const row = results[results.length - 1]!.results[0] as { status: string; refundId: number | null; refundStatus: RefundStatus | null } | undefined;
  if (!row || row.status !== "completed") return fail("shipment_return_wrong_state");
  // 讀到已收回之後被別人搶先記錄：只有確認內容相同才算重送，這裡 batch 內的明細寫入已被擋下，所以重新比對
  if (!changed && found.status === "received") {
    const latest = await db.select({ orderLineId: shipmentReturnItems.orderLineId, sellableQuantity: shipmentReturnItems.sellableQuantity }).from(shipmentReturnItems).where(eq(shipmentReturnItems.returnId, returnId));
    if (!latest.every((rowItem) => rowItem.sellableQuantity === (inputOf(rowItem.orderLineId)?.sellableQuantity ?? 0))) return fail("shipment_return_wrong_state");
  }
  return ok({ returnId, replayed: !changed, refund: row.refundId === null ? null : { id: row.refundId, status: row.refundStatus! } });
}
