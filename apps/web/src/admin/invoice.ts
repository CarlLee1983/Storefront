import { INVOICE_STATUSES } from "@storefront/app/invoices-shared";

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

/** 頁面用的結果參數（redirect 後的 query）：只接受已知的狀態。 */
export function parseInvoiceResult(params: URLSearchParams): { kind: "retry"; status: string } | { kind: "resend"; delivered: boolean } | null {
  const status = params.get("invoice");
  if (status !== null && (INVOICE_STATUSES as readonly string[]).includes(status)) return { kind: "retry", status };
  const resend = params.get("resend");
  if (resend === "delivered" || resend === "failed") return { kind: "resend", delivered: resend === "delivered" };
  return null;
}
