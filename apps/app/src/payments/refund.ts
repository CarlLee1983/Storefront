import type { OrderStatus } from "../orders/schema";
import type { RefundReason } from "./shared";

/**
 * 付款成功、但沒有讓訂單轉為已付款時，該不該退款、為什麼（CONTEXT.md「退款」的三種情況）。
 * `orderStatus` 是套用之後才讀到的訂單狀態；訂單轉換只往前走，所以這個狀態就是沒轉成的原因：
 * - 已逾期：遲到的付款成功，重新保留不到庫存。
 * - 已取消：付款成功落在已取消的訂單上。
 * - 已付款、部分出貨、已出貨：訂單已經由「另一筆」付款轉為已付款，這筆是第二筆成功付款（安全網）。
 * 待付款不可能發生（付款成功一定會讓待付款訂單轉走），回 null：不退款，呼叫端記 log。
 */
export function refundReasonFor(orderStatus: OrderStatus): RefundReason | null {
  switch (orderStatus) {
    case "expired":
      return "late_success_unreclaimable";
    case "cancelled":
      return "cancelled_order";
    case "paid":
    case "partially_shipped":
    case "shipped":
      return "duplicate_success";
    case "pending_payment":
      return null;
  }
}
