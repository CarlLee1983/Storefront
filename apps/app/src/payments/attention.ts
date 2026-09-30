import { sql, type SQL } from "drizzle-orm";
import { orders } from "../orders/schema";
import { payments } from "./schema";

/**
 * 「付款成功但未處理」（需要處理）的推導條件，付款摘要與管理端訂單清單共用這一份：
 * - 付款是 succeeded、沒有退款紀錄，而且訂單不是「由這一筆付款」支付的：訂單不是已付款／已出貨，
 *   或訂單的 `paid_by_payment_id` 是另一筆付款。所以訂單是已逾期或已取消（重新保留不到、或已取消卻收到成功）、
 *   或訂單已由另一筆付款支付（第二筆成功）都會標記。
 * - 付款是 refund_failed：閘道退款失敗，款項還沒退回，同樣需要人處理。
 * 正常流程下成功的付款會在同一次呼叫裡被退款並記下紀錄；會停在 succeeded 且沒有紀錄，只有套用付款結果的 batch 之後、
 * 退款記錄之前程序中斷。這是揭露，不是修復：不會自動補退款，也沒有手動退款的操作。
 *
 * 引用外層的 `payments` 與 `orders` 欄位；呼叫端的查詢必須有這兩張表。
 */
export function paymentNeedsAttentionSql(): SQL {
  return sql`(
    ${payments.status} = 'refund_failed'
    OR (
      ${payments.status} = 'succeeded' AND ${payments.refundReason} IS NULL
      AND NOT (${orders.status} IN ('paid', 'shipped') AND ${orders.paidByPaymentId} = ${payments.id})
    )
  )`;
}
