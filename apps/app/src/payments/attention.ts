import { sql, type SQL } from "drizzle-orm";
import { orders } from "../orders/schema";
import { payments } from "./schema";

/**
 * 「付款成功但未處理」（需要處理）的推導條件，付款摘要與管理端訂單清單共用這一份：
 * - 這筆付款有尚未成功的退款（登記後還沒送出、進行中、結果不明或明確失敗）：款項還沒退回，需要人處理（見 `refunds.ts`）。
 * - 付款是 succeeded、沒有任何退款紀錄，而且訂單不是「由這一筆付款」支付的：訂單不是已付款／已出貨，
 *   或訂單的 `paid_by_payment_id` 是另一筆付款。所以訂單是已逾期或已取消（重新保留不到、或已取消卻收到成功）、
 *   或訂單已由另一筆付款支付（第二筆成功）都會標記。
 * 正常流程下成功的付款會在同一次呼叫裡登記退款；會停在 succeeded 且沒有紀錄，只有套用付款結果的 batch 之後、
 * 登記退款之前程序中斷，事件重送時會補登記（見 `service.ts` 的 `applyEvent`）。
 *
 * 引用外層的 `payments` 與 `orders` 欄位；呼叫端的查詢必須有這兩張表。
 */
export function paymentNeedsAttentionSql(): SQL {
  return sql`(
    EXISTS (SELECT 1 FROM refunds WHERE refunds.payment_id = ${payments.id} AND refunds.status <> 'succeeded')
    OR (
      ${payments.status} = 'succeeded'
      AND NOT EXISTS (SELECT 1 FROM refunds WHERE refunds.payment_id = ${payments.id})
      AND NOT (${orders.status} IN ('paid', 'partially_shipped', 'shipped') AND ${orders.paidByPaymentId} = ${payments.id})
    )
  )`;
}
