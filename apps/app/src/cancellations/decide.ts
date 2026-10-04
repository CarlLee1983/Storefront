import { sql, type SQL } from "drizzle-orm";
import { insertCancellationApprovedNotice, insertCancellationRejectedNotice } from "../contact/notices";
import { CANCELLED, SHIPPED } from "../orders/schema";
import { canTransitionTo } from "../orders/transitions";
import { CANCELLATION_CASE, shippingRefundSql } from "../payments/exit-refund";
import { newGatewayRefundId, withinQuotaSql } from "../payments/refunds";
import type { RefundStatus } from "../payments/shared";
import { batchAtEffectiveNow, effectiveNow } from "../shared/high-water-mark";
import { fail, ok } from "../shared/result";
import { dispatchedQuantity } from "../shipments/queries";
import type { DecideCancellationInput } from "./input";
import { approvedCancelledQuantity } from "./queries";
import type { CancellationStatus } from "./schema";

export type DecideCancellationFailure = "cancellation_not_found" | "cancellation_already_decided";

export type DecideCancellationResult =
  | {
      ok: true;
      data: {
        requestId: number;
        decision: Exclude<CancellationStatus, "pending">;
        /** 這次呼叫不是第一次做出這個決定（重送）。 */
        replayed: boolean;
        /** 核准後登記的退款；額度不足而尚未登記為 null（重送核准會再嘗試登記）。 */
        refund: { id: number; status: RefundStatus } | null;
      };
    }
  | { ok: false; reason: DecideCancellationFailure };

/**
 * 管理員審核一案取消申請（ADR 0007）；單一 batch，同成同敗，是否做成由條件寫入的結果判斷（不先讀再寫）。
 *
 * 拒絕：待審 → 拒絕，數量不再被占用，恢復可交運；寫拒絕通知。
 *
 * 核准：
 * 1. 待審 → 核准，同一句算定退款拆分：商品款 = 各明細取消數量 × 原實付單價（下單時的單價快照，已是特價後的實付價），
 *    運費依 `shippingRefundSql`（同類全數退出，含完成退貨的數量；見 `payments/exit-refund.ts`）。核准即釋放保留（保留量減去已核准取消，見 `catalog/stock.ts`）、停止該數量履約。
 * 2. 訂單狀態：每筆明細都核准取消 → 已取消；否則若剩餘數量都已交運 → 已出貨。其餘維持（仍有未交運或待審的數量）。
 * 3. 登記這一案的退款（唯一索引保證一案一筆）：額度條件與其他退款共用 `withinQuotaSql`（成功加所有未結承諾不超過實收），
 *    綁定讓訂單成立的那筆付款；退款登記在核准的同一個 batch，所以不會有「核准了卻漏開退款」的空窗，
 *    額度不足時核准照樣成立（退款是否成功不改變取消結果），重送核准會再嘗試登記。
 * 4. 核准通知。
 * 退款的執行（向閘道送出）在 batch 之外，由呼叫端接續；失敗不恢復出貨，退款留在逐筆退款的待辦裡重試。
 * 同一決定重送回 `replayed: true`；已做出相反決定回 `cancellation_already_decided`。
 */
export async function decideCancellation(d1: D1Database, request: DecideCancellationInput & { actor: string }, now: number): Promise<DecideCancellationResult> {
  const { requestId, decision, note, actor } = request;
  const statements: SQL[] = decision === "reject"
    ? [
        sql`
          UPDATE cancellation_requests
          SET status = 'rejected', decided_at = ${effectiveNow}, decided_by = ${actor}, decision_note = ${note}
          WHERE id = ${requestId} AND status = 'pending'
        `,
        insertCancellationRejectedNotice(requestId),
      ]
    : [
        sql`
          UPDATE cancellation_requests
          SET status = 'approved', decided_at = ${effectiveNow}, decided_by = ${actor}, decision_note = ${note},
            goods_twd = (
              SELECT COALESCE(SUM(item.quantity * line.unit_price_twd), 0)
              FROM cancellation_request_items item JOIN order_lines line ON line.id = item.order_line_id
              WHERE item.request_id = cancellation_requests.id
            ),
            standard_shipping_twd = ${shippingRefundSql(CANCELLATION_CASE, "standard", "standard_shipping_fee_twd", "standard_shipping_twd")},
            large_shipping_twd = ${shippingRefundSql(CANCELLATION_CASE, "large", "large_shipping_fee_twd", "large_shipping_twd")}
          WHERE id = ${requestId} AND status = 'pending'
        `,
        sql`
          UPDATE orders SET status = ${CANCELLED}
          WHERE id = (SELECT order_id FROM cancellation_requests WHERE id = ${requestId} AND status = 'approved') AND ${canTransitionTo(CANCELLED)}
            AND NOT EXISTS (SELECT 1 FROM order_lines line WHERE line.order_id = orders.id AND line.quantity > ${approvedCancelledQuantity(sql`line.id`)})
        `,
        sql`
          UPDATE orders SET status = ${SHIPPED}
          WHERE id = (SELECT order_id FROM cancellation_requests WHERE id = ${requestId} AND status = 'approved') AND ${canTransitionTo(SHIPPED)}
            AND NOT EXISTS (SELECT 1 FROM order_lines line WHERE line.order_id = orders.id AND line.quantity - ${approvedCancelledQuantity(sql`line.id`)} > ${dispatchedQuantity(sql`line.id`)})
        `,
        sql`
          INSERT INTO refunds (order_id, payment_id, reason, gateway_refund_id, amount_twd, goods_twd, shipping_twd, status, cancellation_request_id, created_at)
          SELECT cr.order_id, p.id, 'cancellation', ${newGatewayRefundId()},
            cr.goods_twd + cr.standard_shipping_twd + cr.large_shipping_twd, cr.goods_twd, cr.standard_shipping_twd + cr.large_shipping_twd,
            'pending', cr.id, ${effectiveNow}
          FROM cancellation_requests cr
          JOIN orders o ON o.id = cr.order_id
          JOIN payments p ON p.id = o.paid_by_payment_id
          WHERE cr.id = ${requestId} AND cr.status = 'approved'
            AND ${withinQuotaSql(sql`(cr.goods_twd + cr.standard_shipping_twd + cr.large_shipping_twd)`)}
          ON CONFLICT (cancellation_request_id) DO NOTHING
        `,
        insertCancellationApprovedNotice(requestId),
      ];

  const results = await batchAtEffectiveNow(d1, now, [
    ...statements,
    sql`
      SELECT cr.status AS status, refund.id AS refundId, refund.status AS refundStatus
      FROM cancellation_requests cr LEFT JOIN refunds refund ON refund.cancellation_request_id = cr.id
      WHERE cr.id = ${requestId}
    `,
  ]);

  const changed = results[0]!.meta.changes > 0;
  const found = results[results.length - 1]!.results[0] as { status: CancellationStatus; refundId: number | null; refundStatus: RefundStatus | null } | undefined;
  if (!found) return fail("cancellation_not_found");
  const decided = decision === "approve" ? "approved" : "rejected";
  if (found.status !== decided) return fail("cancellation_already_decided");
  return ok({
    requestId,
    decision: decided,
    replayed: !changed,
    refund: found.refundId === null ? null : { id: found.refundId, status: found.refundStatus! },
  });
}
