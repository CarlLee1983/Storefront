// 付款的共用常數與型別：App 內部與 Web（經 `@storefront/app/payments-shared`）共用，各自只在這裡定義一次。
// 不 import 任何東西，Web 打包時只會帶進這些常數。

/** 閘道發的付款 ID 與事件 ID 是不透明字串；只擋掉空值、過長與含奇怪字元的輸入。 */
export const GATEWAY_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;

/**
 * 付款狀態，與金流閘道的狀態一一對應；存英文代碼，資料表的 CHECK 由這份清單產生。
 * 退款不改付款狀態：成功的付款維持 succeeded，每筆退款的金額與進度記在 `refunds`（見 `REFUND_STATUSES`）。
 */
export const PAYMENT_STATUSES = ["pending", "succeeded", "failed", "expired"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/**
 * 退款的觸發原因（CONTEXT.md「退款」）：
 * 遲到的付款成功保留不到庫存、付款成功落在已取消的訂單上、同一張訂單出現第二筆成功付款（安全網），以及管理員核准的取消申請（#116，一案一筆）。
 * 前三者是付款層級的原因（一筆付款每個原因最多一筆）；取消退款綁定取消申請，不受該唯一索引限制。
 */
export const REFUND_REASONS = ["late_success_unreclaimable", "cancelled_order", "duplicate_success", "cancellation"] as const;
export type RefundReason = (typeof REFUND_REASONS)[number];

/**
 * 退款（逐筆）的進度，ADR 0007：
 * - `pending`：已登記、尚未送出（含等同單前一筆結果確定）；
 * - `processing`：正在向閘道送出或查證，同張訂單同時最多一筆；
 * - `unknown`：結果不明（逾時、連不上、回應異常），須先向閘道查證，期間阻擋同單後筆；
 * - `failed`：閘道明確失敗，可重試，後筆可前進，仍保留額度；
 * - `succeeded`：款項已退回。
 * 除 `succeeded` 外都佔用可退額度。
 */
export const REFUND_STATUSES = ["pending", "processing", "unknown", "failed", "succeeded"] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];

/** 退款嘗試的動作：直接送出，或結果不明後先向閘道查證。 */
export const REFUND_ATTEMPT_ACTIONS = ["send", "verify"] as const;
export type RefundAttemptAction = (typeof REFUND_ATTEMPT_ACTIONS)[number];

/** 一次退款嘗試的結果：成功、明確失敗、結果不明，或查證時閘道從未收過這筆退款。 */
export const REFUND_ATTEMPT_OUTCOMES = ["succeeded", "failed", "unknown", "not_found"] as const;
export type RefundAttemptOutcome = (typeof REFUND_ATTEMPT_OUTCOMES)[number];

/**
 * 補查（不依賴顧客返回頁面的付款查證）沒能確認付款結果的原因，也是待辦的種類：
 * 閘道查不到（連不上、回錯、格式不符）、閘道回的金額或商家參照與本站不符、閘道回的狀態無法套用（成功或失敗卻沒有事件 ID）。
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
