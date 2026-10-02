import { toText } from "../shared/form-values";

/** 帳戶頁「送出聯絡 email」表單 → RPC 輸入；格式與正規化（去空白、轉小寫）由 App 驗證。 */
export function contactFormToInput(form: FormData) {
  return { email: toText(form.get("email")) };
}

/** 要求驗證失敗 → 頁面訊息（固定文案，不回顯 App 原始文字）；`unauthorized` 由頁面另外處理（導向登入）。 */
export function describeContactFailure(result: { reason: string }): string {
  const messages: Record<string, string> = {
    invalid_input: "請輸入有效的 email。",
    already_verified: "這個 email 已經是你的聯絡 email，不需要再驗證。",
    too_many_requests: "送出太頻繁，請 10 分鐘後再試；已寄出的驗證信仍可在我的信箱開啟。",
  };
  return Object.hasOwn(messages, result.reason) ? messages[result.reason]! : "目前無法送出驗證信，請稍後再試。";
}

/** 驗證連結失敗 → 頁面訊息。 */
export function describeVerifyFailure(result: { reason: string }): string {
  const messages: Record<string, string> = {
    invalid_input: "驗證連結無效，請從你的信箱重新開啟。",
    invalid_token: "驗證連結無效。請確認目前登入的帳號與收到驗證信的帳號相同，並使用信箱中最新的連結。",
    verification_closed: "這個驗證連結已過期，或已被較新的驗證請求取代。請回到帳戶頁重新送出 email。",
  };
  return Object.hasOwn(messages, result.reason) ? messages[result.reason]! : "目前無法完成驗證，請稍後再試。";
}

const MAIL_KIND_LABELS: Record<string, string> = {
  contact_verification: "聯絡 email 驗證",
  order_placed: "下單通知",
  payment_succeeded: "付款成功通知",
  payment_failed: "付款失敗通知",
  payment_unsettled: "付款未能生效通知",
  refund_succeeded: "退款通知",
  shipment_dispatched: "出貨通知",
  shipment_delivered: "送達通知",
  shipment_delivery_failed: "配送異常通知",
};

/** 信件種類的顯示名稱；不認得的種類不顯示原始代碼。 */
export function mailKindLabel(kind: string): string {
  return Object.hasOwn(MAIL_KIND_LABELS, kind) ? MAIL_KIND_LABELS[kind]! : "通知";
}

const VERIFICATION_STATUS_LABELS: Record<string, string> = {
  verified: "這個地址已完成驗證。",
  superseded: "這個驗證連結已被較新的驗證請求取代。",
  expired: "這個驗證連結已過期，請回到帳戶頁重新送出 email。",
};

/** 驗證信中已不能使用的驗證連結的說明；還能用（pending）或不認得的狀態回 null。 */
export function verificationStatusNote(status: string): string | null {
  return Object.hasOwn(VERIFICATION_STATUS_LABELS, status) ? VERIFICATION_STATUS_LABELS[status]! : null;
}

/** 投遞結果的顯示名稱（管理端）。 */
export function deliveryStatusLabel(status: string): string {
  return status === "delivered" ? "已送達" : status === "failed" ? "投遞失敗" : "狀態待確認";
}

/** 管理端操作失敗 → 訊息；`unauthorized` 由頁面另外處理（403）。 */
export function describeMailAdminFailure(result: { reason: string }): string {
  const messages: Record<string, string> = {
    invalid_input: "輸入有誤，請重新整理後再試",
    message_not_found: "找不到這封信",
    message_not_resendable: "這封驗證信的驗證請求已過期或被取代，不能重送；請顧客重新送出 email",
    no_verified_contact: "這位顧客目前沒有已驗證的聯絡 email，不能重送；請顧客先驗證聯絡 email",
  };
  return Object.hasOwn(messages, result.reason) ? messages[result.reason]! : "操作失敗，請稍後再試";
}

/** 網址上的信件編號；不是正整數就回傳 null（頁面顯示找不到）。 */
export function parseMessageId(value: string | undefined): number | null {
  return value !== undefined && /^[1-9]\d*$/.test(value) ? Number(value) : null;
}

/** 結帳需要先驗證聯絡 email 時導去的帳戶頁（帶 reason 讓頁面說明原因）。 */
export const CHECKOUT_CONTACT_PATH = "/account?reason=checkout";
