import type { OrderStatus } from "../orders/schema";
import { PAYMENT_CUTOFF_BEFORE_DEADLINE_MS } from "../orders/payment-deadline";
import { isPayableStatus } from "./payable";

export type StartRefusal = "order_not_payable" | "payment_already_succeeded" | "payment_in_progress" | "payment_deadline_passed" | "payment_window_closed";

/**
 * 發起付款被拒的原因（唯讀診斷，不是判定）：真正的判定在 `insertPaymentIfPayable` 的單句條件寫入裡，
 * 這裡只用來在呼叫閘道之前擋掉明顯不行的請求，以及寫入被拒後說明原因。可以付款回 null。
 * `now` 是系統時鐘：高水位不會小於它，所以這裡說「已過期」時，判定也一定會說已過期；反過來則要以寫入為準。
 */
export function diagnoseStart(
  order: { status: OrderStatus; paymentDeadline: number },
  payments: { hasSucceeded: boolean; hasPending: boolean },
  now: number,
): StartRefusal | null {
  if (!isPayableStatus(order.status)) return "order_not_payable";
  if (payments.hasSucceeded) return "payment_already_succeeded";
  if (payments.hasPending) return "payment_in_progress";
  if (now >= order.paymentDeadline) return "payment_deadline_passed";
  // 付款期限前 2 分鐘內不再發起（ADR 0001）：付款有效期會比期限短，這段時間發起的付款幾乎立刻失效
  if (now >= order.paymentDeadline - PAYMENT_CUTOFF_BEFORE_DEADLINE_MS) return "payment_window_closed";
  return null;
}
