// 付款的共用常數與型別：App 內部與 Web（經 `@storefront/app/payments-shared`）共用，各自只在這裡定義一次。
// 不 import 任何東西，Web 打包時只會帶進這些常數。

/** 閘道發的付款 ID 與事件 ID 是不透明字串；只擋掉空值、過長與含奇怪字元的輸入。 */
export const GATEWAY_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;

/**
 * 付款狀態，與金流閘道的狀態一一對應；存英文代碼，資料表的 CHECK 由這份清單產生。
 * 退款的結果也記在付款狀態上：成功的付款退款成功轉為 refunded，閘道退款失敗轉為 refund_failed。
 */
export const PAYMENT_STATUSES = ["pending", "succeeded", "failed", "expired", "refunded", "refund_failed"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/**
 * 退款的觸發原因（CONTEXT.md「退款」的三種情況）：
 * 遲到的付款成功保留不到庫存、付款成功落在已取消的訂單上、同一張訂單出現第二筆成功付款（安全網）。
 */
export const REFUND_REASONS = ["late_success_unreclaimable", "cancelled_order", "duplicate_success"] as const;
export type RefundReason = (typeof REFUND_REASONS)[number];

/**
 * 補查（不依賴顧客返回頁面的付款查證）沒能確認付款結果的原因，也是待辦的種類：
 * 閘道查不到（連不上、回錯、格式不符）、閘道回的金額或商家參照與本站不符、閘道回的狀態無法套用（成功或失敗卻沒有事件 ID，或本地還在等待時閘道已退款）。
 */
export const RECONCILE_ISSUE_REASONS = ["gateway_unavailable", "gateway_mismatch", "result_unclear"] as const;
export type ReconcileIssueReason = (typeof RECONCILE_ISSUE_REASONS)[number];

/** 讓訂單上進行中的付款失效（發起新付款、顧客取消訂單共用）被拒絕的原因。 */
export type InvalidatePaymentsRefusal = "payment_unavailable" | "payment_gateway_unavailable" | "payment_in_progress" | "payment_already_succeeded";

/** 付款結果事件的結果：只有終局的成功或失敗會被套用。 */
export const PAYMENT_OUTCOMES = ["succeeded", "failed"] as const;
export type PaymentOutcome = (typeof PAYMENT_OUTCOMES)[number];

/** 「套用付款結果」的輸入：閘道的一個付款結果事件（webhook 與導回查詢共用）。 */
export interface PaymentEvent {
  eventId: string;
  gatewayPaymentId: string;
  outcome: PaymentOutcome;
}
