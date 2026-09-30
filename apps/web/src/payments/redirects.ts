import { GATEWAY_ID_PATTERN } from "@storefront/app/payments-shared";
import { parseOrderId } from "../orders/labels";

/** 閘道導回 `/orders/:id/payment-return?paymentId=…` 的參數；不合法回 null。 */
export function parsePaymentReturn(
  orderIdParam: string | undefined,
  search: URLSearchParams,
): { orderId: number; gatewayPaymentId: string } | null {
  const orderId = parseOrderId(orderIdParam);
  const gatewayPaymentId = search.get("paymentId");
  return orderId !== null && gatewayPaymentId !== null && GATEWAY_ID_PATTERN.test(gatewayPaymentId) ? { orderId, gatewayPaymentId } : null;
}

/** 導回確認完，顧客回到哪裡：一律是訂單頁；閘道查詢失敗或付款設定不全時標記「暫時無法確認」，讓頁面說明。 */
export function paymentReturnLocation(orderId: number, result: { ok: true } | { ok: false; reason: string }): string {
  const unconfirmed = !result.ok && (result.reason === "payment_gateway_unavailable" || result.reason === "payment_unavailable");
  return unconfirmed ? `/orders/${orderId}?payment=unconfirmed` : `/orders/${orderId}`;
}

/** 發起付款之後：成功導向閘道的付款頁，被拒回訂單頁並帶上原因（頁面用 `paymentErrorMessage` 顯示）。 */
export function startPaymentLocation(
  orderId: number,
  result: { ok: true; data: { paymentUrl: string } } | { ok: false; reason: string },
): string {
  return result.ok ? result.data.paymentUrl : `/orders/${orderId}?payment_error=${encodeURIComponent(result.reason)}`;
}

const ERROR_MESSAGES: Record<string, string> = {
  order_not_payable: "這張訂單目前不能付款。",
  payment_deadline_passed: "已超過付款期限，無法付款。",
  payment_in_progress: "這張訂單有一筆付款正在進行中，請先完成它，或稍後再試。",
  payment_already_succeeded: "這張訂單已經有一筆付款成功。",
  payment_gateway_unavailable: "金流暫時無法使用，請稍後再試。",
  payment_unavailable: "付款功能尚未開放，請稍後再試。",
};

const GENERIC_ERROR = "無法發起付款，請稍後再試。";

/** 訂單頁網址上 `payment_error` 對應的說明；沒有帶就是 null，不認得的原因用通用說明（不回顯網址上的字串）。 */
export function paymentErrorMessage(reason: string | null): string | null {
  if (reason === null) return null;
  return Object.hasOwn(ERROR_MESSAGES, reason) ? ERROR_MESSAGES[reason]! : GENERIC_ERROR;
}
