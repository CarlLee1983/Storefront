import { eq, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { insertLossConfirmedNotice } from "../contact/notices";
import { lossShippingRefundSql } from "../payments/exit-refund";
import { newGatewayRefundId, withinQuotaSql } from "../payments/refunds";
import type { RefundStatus } from "../payments/shared";
import { heldByReturnBatchQuantity, heldByReturnQuantity } from "../returns/queries";
import { heldByShipmentReturnQuantity, returnedInBatchQuantity } from "../shipment-returns/quantities";
import { batchAtEffectiveNow, effectiveNow } from "../shared/high-water-mark";
import { hashCaseRequest } from "../shared/request-hash";
import { fail, ok } from "../shared/result";
import type { ConfirmShipmentLossInput } from "./loss-input";
import { dispatchedQuantity, lostInBatchQuantity, lostQuantity } from "./queries";
import { shipmentItems, shipments } from "./schema";

export type ConfirmLossFailure = "shipment_not_found" | "shipment_delivered" | "loss_line_invalid" | "loss_quantity_exceeded" | "loss_key_conflict";

export type ConfirmLossResult =
  | {
      ok: true;
      data: {
        lossId: number;
        /** 這次呼叫不是第一次確認這案遺失（重送）。 */
        replayed: boolean;
        /** 確認後登記的退款；額度不足而尚未登記為 null（重送會再嘗試登記）。 */
        refund: { id: number; status: RefundStatus } | null;
      };
    }
  | { ok: false; reason: ConfirmLossFailure };

/**
 * 管理員確認某一批的部分商品遺失（ADR 0006、0007；設計文件 Q5、Q20、Q25）。單一 batch，同成同敗，是否成立由條件寫入的結果判斷（不先讀再寫）：
 * 1. 建立遺失案件：批次尚未送達（有實際送達時間就是已送達，包含部分遺失之後才送達的批次；已送達是終點，不可再確認遺失；暫時配送失敗不是遺失，所以失敗與再次配送中的批次可以確認），
 *    且每筆遺失明細都在這一批裡，「該批已遺失 + 該批自助退貨占用 + 該批物流退回占用 + 本次」不超過該批數量，
 *    「明細已遺失 + 退貨占用 + 物流退回占用 + 本次」不超過明細已交運數量（與退貨申請 `returns/request.ts`、物流退回 `shipment-returns/declare.ts` 共用同一份數量，同一句條件寫入互斥；待審與核准中的退貨也占用，須先處理）。
 *    同一句算定退款拆分：商品款 = 遺失數量 × 原實付單價，原運費依 `lossShippingRefundSql`（任一該類遺失就退該類整類原運費一次，與取消、退貨、別案遺失互斥，見 `payments/exit-refund.ts`）。
 * 2. 寫遺失明細（只在這案還沒有明細時）、3. 批次進度改為 `lost`（優先於送達與失敗回報，見 `shipments/events.ts`）。
 *    遺失不寫庫存流水、不動在庫與保留：貨已交運、不在倉內，不回補庫存；之後若物流尋回並退回倉庫，登記物流退回時可標示為尋回的遺失品（入庫但不再退款，見 `shipment-returns/declare.ts`）；也不從同單補寄，需要再購買須重新下單。
 * 4. 登記這案的退款（唯一索引保證一案一筆）：額度條件與其他退款共用 `withinQuotaSql`，綁定讓訂單成立的那筆付款；
 *    額度不足時確認照樣成立（款項是否退成功不改變遺失事實），列進退款待辦，重送同一確認會再嘗試登記。
 * 5. 通知，與確認同一個 batch。退款的執行（向閘道送出）在 batch 之外，由呼叫端接續。
 * 同鍵同內容重送回 `replayed: true`；同鍵不同內容回 `loss_key_conflict`。
 */
export async function confirmShipmentLoss(
  d1: D1Database,
  db: DrizzleD1Database,
  request: ConfirmShipmentLossInput,
  actor: string,
  now: number,
): Promise<ConfirmLossResult> {
  const { shipmentId, lossKey, note } = request;
  const items = [...request.items].sort((a, b) => a.orderLineId - b.orderLineId);

  const [shipment] = await db.select({ id: shipments.id }).from(shipments).where(eq(shipments.id, shipmentId));
  if (!shipment) return fail("shipment_not_found");

  const requestHash = await hashCaseRequest(items, note);
  const itemsJson = JSON.stringify(items);
  const lossId = sql`(SELECT id FROM shipment_losses WHERE shipment_id = ${shipmentId} AND loss_key = ${lossKey})`;
  const total = sql`(sl.goods_twd + sl.standard_shipping_twd + sl.large_shipping_twd)`;

  const results = await batchAtEffectiveNow(d1, now, [
    sql`
      INSERT INTO shipment_losses (order_id, shipment_id, loss_key, request_hash, note, confirmed_at, actor, goods_twd, standard_shipping_twd, large_shipping_twd)
      SELECT ship.order_id, ship.id, ${lossKey}, ${requestHash}, ${note}, ${effectiveNow}, ${actor},
        (SELECT COALESCE(SUM(json_extract(item.value, '$.quantity') * line.unit_price_twd), 0) FROM json_each(${itemsJson}) item JOIN order_lines line ON line.id = json_extract(item.value, '$.orderLineId')),
        ${lossShippingRefundSql(sql`ship.order_id`, itemsJson, "standard", "standard_shipping_fee_twd", "standard_shipping_twd")},
        ${lossShippingRefundSql(sql`ship.order_id`, itemsJson, "large", "large_shipping_fee_twd", "large_shipping_twd")}
      FROM shipments ship
      WHERE ship.id = ${shipmentId} AND ship.delivery_status <> 'delivered' AND ship.delivered_at IS NULL AND ${lossId} IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM json_each(${itemsJson}) item
          LEFT JOIN shipment_items ship_item ON ship_item.shipment_id = ship.id AND ship_item.order_line_id = json_extract(item.value, '$.orderLineId')
          WHERE ship_item.id IS NULL
            OR ${lostInBatchQuantity(sql`ship_item.order_line_id`, sql`ship.id`)} + ${heldByReturnBatchQuantity(sql`ship_item.order_line_id`, sql`ship.id`)} + ${returnedInBatchQuantity(sql`ship_item.order_line_id`, sql`ship.id`)} + json_extract(item.value, '$.quantity') > ship_item.quantity
            OR ${lostQuantity(sql`ship_item.order_line_id`)} + ${heldByReturnQuantity(sql`ship_item.order_line_id`)} + ${heldByShipmentReturnQuantity(sql`ship_item.order_line_id`)} + json_extract(item.value, '$.quantity') > ${dispatchedQuantity(sql`ship_item.order_line_id`)}
        )
      ON CONFLICT (shipment_id, loss_key) DO NOTHING
    `,
    sql`
      INSERT INTO shipment_loss_items (loss_id, order_line_id, quantity)
      SELECT ${lossId}, json_extract(item.value, '$.orderLineId'), json_extract(item.value, '$.quantity')
      FROM json_each(${itemsJson}) item
      WHERE ${lossId} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM shipment_loss_items WHERE loss_id = ${lossId})
    `,
    sql`UPDATE shipments SET delivery_status = 'lost' WHERE id = ${shipmentId} AND ${lossId} IS NOT NULL AND delivery_status <> 'lost'`,
    sql`
      INSERT INTO refunds (order_id, payment_id, reason, gateway_refund_id, amount_twd, goods_twd, shipping_twd, status, shipment_loss_id, created_at)
      SELECT sl.order_id, p.id, 'loss', ${newGatewayRefundId()}, ${total}, sl.goods_twd, sl.standard_shipping_twd + sl.large_shipping_twd, 'pending', sl.id, ${effectiveNow}
      FROM shipment_losses sl
      JOIN orders o ON o.id = sl.order_id
      JOIN payments p ON p.id = o.paid_by_payment_id
      WHERE sl.id = ${lossId} AND ${total} > 0 AND ${withinQuotaSql(total)}
      ON CONFLICT (shipment_loss_id) DO NOTHING
    `,
    insertLossConfirmedNotice(lossId),
    sql`
      SELECT sl.id AS id, sl.request_hash AS requestHash, refund.id AS refundId, refund.status AS refundStatus
      FROM shipment_losses sl LEFT JOIN refunds refund ON refund.shipment_loss_id = sl.id
      WHERE sl.shipment_id = ${shipmentId} AND sl.loss_key = ${lossKey}
    `,
  ]);

  const created = results[0]!.meta.changes > 0;
  const found = results[results.length - 1]!.results[0] as { id: number; requestHash: string; refundId: number | null; refundStatus: RefundStatus | null } | undefined;
  if (!found) {
    // 寫入被擋下：已送達、明細不在這一批，或數量被占用／已遺失（全部由上面那句條件寫入判斷，這裡只讀出原因）
    const [current] = await db.select({ deliveryStatus: shipments.deliveryStatus, deliveredAt: shipments.deliveredAt }).from(shipments).where(eq(shipments.id, shipmentId));
    if (current?.deliveryStatus === "delivered" || (current?.deliveredAt ?? null) !== null) return fail("shipment_delivered");
    const inBatch = new Set((await db.select({ orderLineId: shipmentItems.orderLineId }).from(shipmentItems).where(eq(shipmentItems.shipmentId, shipmentId))).map((row) => row.orderLineId));
    return fail(items.some((item) => !inBatch.has(item.orderLineId)) ? "loss_line_invalid" : "loss_quantity_exceeded");
  }
  if (!created && found.requestHash !== requestHash) return fail("loss_key_conflict");
  return ok({ lossId: found.id, replayed: !created, refund: found.refundId === null ? null : { id: found.refundId, status: found.refundStatus! } });
}
