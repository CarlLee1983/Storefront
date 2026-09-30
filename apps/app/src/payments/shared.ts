// 付款的共用常數與型別：App 內部與 Web（經 `@storefront/app/payments-shared`）共用，各自只在這裡定義一次。
// 不 import 任何東西，Web 打包時只會帶進這些常數。

/** 閘道發的付款 ID 與事件 ID 是不透明字串；只擋掉空值、過長與含奇怪字元的輸入。 */
export const GATEWAY_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;

/**
 * 付款狀態，與金流閘道的狀態一一對應；存英文代碼，資料表的 CHECK 由這份清單產生。
 * 本票只會寫入 pending / succeeded / failed / expired，退款的兩個狀態留給 #11。
 */
export const PAYMENT_STATUSES = ["pending", "succeeded", "failed", "expired", "refunded", "refund_failed"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** 付款結果事件的結果：只有終局的成功或失敗會被套用。 */
export const PAYMENT_OUTCOMES = ["succeeded", "failed"] as const;
export type PaymentOutcome = (typeof PAYMENT_OUTCOMES)[number];

/** 「套用付款結果」的輸入：閘道的一個付款結果事件（webhook 與導回查詢共用）。 */
export interface PaymentEvent {
  eventId: string;
  gatewayPaymentId: string;
  outcome: PaymentOutcome;
}
