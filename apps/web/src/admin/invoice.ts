import { ALLOWANCE_STATUSES, INVOICE_STATUSES } from "@storefront/app/invoices-shared";

/** 補辦發票 RPC 的結果 → 頁面上的提示；`status` 是這次操作之後發票的狀態。 */
export function describeInvoiceRetryOutcome(status: string): { text: string; isError: boolean } {
  switch (status) {
    case "issued":
      return { text: "發票已開立，顧客的訂單頁與通知已更新。", isError: false };
    case "failed":
      return { text: "發票服務明確拒絕這次開立：可再補辦；持續失敗請檢查閘道的發票服務。", isError: true };
    case "unknown":
      return { text: "仍無法確認發票是否已開立（結果不明）：不會重複開立，請稍後再按「查證並補辦」。", isError: true };
    default:
      return { text: "發票尚未開立，請重新整理清單確認進度。", isError: true };
  }
}

/** 補辦折讓 RPC 的結果 → 頁面上的提示；`status` 是這次操作之後折讓的狀態。 */
export function describeAllowanceRetryOutcome(status: string): { text: string; isError: boolean } {
  switch (status) {
    case "issued":
      return { text: "折讓已完成，顧客的訂單頁與通知已更新。", isError: false };
    case "failed":
      return { text: "發票服務明確拒絕這次折讓：可再補辦；持續失敗請檢查閘道的發票服務與原票金額。", isError: true };
    case "unknown":
      return { text: "仍無法確認折讓是否已完成（結果不明）：不會重複折讓，請稍後再按「查證並補辦」。", isError: true };
    default:
      return { text: "折讓尚未完成，請重新整理清單確認進度。", isError: true };
  }
}

/** 重寄折讓通知的結果 → 提示。 */
export function describeAllowanceResendOutcome(delivered: boolean): { text: string; isError: boolean } {
  return delivered
    ? { text: "折讓通知已重寄到顧客目前已驗證的 email，歷史投遞紀錄與信件內容不變。", isError: false }
    : { text: "重寄的投遞失敗（信件投遞演練控制可能開著「投遞失敗」）：可到信件投遞頁查看，稍後再重寄。", isError: true };
}

/** 補辦或重寄折讓被 RPC 拒絕 → 訊息；`unauthorized` 由頁面另外處理（403）。 */
export function describeAllowanceFailure(result: { reason: string }): string {
  const messages: Record<string, string> = {
    invalid_input: "輸入有誤，請重新整理後再試",
    allowance_not_found: "找不到這筆折讓",
    allowance_not_issued: "這筆折讓還沒有完成，沒有通知可重寄；請先補辦",
    invoice_not_issued: "原票還沒有開立，不能先折讓；請先補辦原票，開立後會自動補折讓",
    no_verified_contact: "顧客目前沒有已驗證的聯絡 email，無法重寄；請顧客先驗證",
    payment_unavailable: "付款設定不全，現在無法向發票服務送出；請確認 GATEWAY_BASE_URL 與 GATEWAY_API_KEY",
  };
  return Object.hasOwn(messages, result.reason) ? messages[result.reason]! : "操作失敗，請稍後再試";
}

/** 重寄憑證的結果 → 提示。 */
export function describeResendOutcome(delivered: boolean): { text: string; isError: boolean } {
  return delivered
    ? { text: "憑證已重寄到顧客目前已驗證的 email，歷史投遞紀錄與憑證內容不變。", isError: false }
    : { text: "重寄的投遞失敗（信件投遞演練控制可能開著「投遞失敗」）：可到信件投遞頁查看，稍後再重寄。", isError: true };
}

/** 補辦或重寄被 RPC 拒絕 → 訊息；`unauthorized` 由頁面另外處理（403）。 */
export function describeInvoiceFailure(result: { reason: string }): string {
  const messages: Record<string, string> = {
    invalid_input: "輸入有誤，請重新整理後再試",
    invoice_not_found: "找不到這張發票",
    invoice_not_issued: "這張發票還沒有開立，沒有憑證可重寄；請先補辦",
    no_verified_contact: "顧客目前沒有已驗證的聯絡 email，無法重寄；請顧客先驗證",
    payment_unavailable: "付款設定不全，現在無法向發票服務送出；請確認 GATEWAY_BASE_URL 與 GATEWAY_API_KEY",
  };
  return Object.hasOwn(messages, result.reason) ? messages[result.reason]! : "操作失敗，請稍後再試";
}

export type InvoiceResult =
  | { kind: "retry"; status: string }
  | { kind: "resend"; delivered: boolean }
  | { kind: "retry-allowance"; status: string }
  | { kind: "resend-allowance"; delivered: boolean };

/** 頁面用的結果參數（redirect 後的 query）：只接受已知的狀態。 */
export function parseInvoiceResult(params: URLSearchParams): InvoiceResult | null {
  const status = params.get("invoice");
  if (status !== null && (INVOICE_STATUSES as readonly string[]).includes(status)) return { kind: "retry", status };
  const resend = params.get("resend");
  if (resend === "delivered" || resend === "failed") return { kind: "resend", delivered: resend === "delivered" };
  const allowance = params.get("allowance");
  if (allowance !== null && (ALLOWANCE_STATUSES as readonly string[]).includes(allowance)) return { kind: "retry-allowance", status: allowance };
  const resendAllowance = params.get("resend-allowance");
  if (resendAllowance === "delivered" || resendAllowance === "failed") return { kind: "resend-allowance", delivered: resendAllowance === "delivered" };
  return null;
}

/** 結果參數 → 頁面上的提示。 */
export function describeInvoiceResult(result: InvoiceResult | null): { text: string; isError: boolean } | null {
  if (result === null) return null;
  switch (result.kind) {
    case "retry":
      return describeInvoiceRetryOutcome(result.status);
    case "resend":
      return describeResendOutcome(result.delivered);
    case "retry-allowance":
      return describeAllowanceRetryOutcome(result.status);
    case "resend-allowance":
      return describeAllowanceResendOutcome(result.delivered);
  }
}
