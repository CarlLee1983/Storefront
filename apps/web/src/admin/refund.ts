import { refundStatusLabel } from "../orders/labels";

const KNOWN_STATUSES = ["succeeded", "failed", "unknown", "pending", "processing"];

/** 重試退款 RPC 的結果 → 頁面上的提示；`status` 是這次操作之後退款的狀態。 */
export function describeRetryOutcome(status: string): { text: string; isError: boolean } {
  switch (status) {
    case "succeeded":
      return { text: "退款已成功，款項已退回，顧客的訂單頁與通知已更新。", isError: false };
    case "failed":
      return { text: `閘道明確拒絕這次退款（${refundStatusLabel(status)}）：額度仍保留，可再重試；持續失敗請檢查閘道。`, isError: true };
    case "unknown":
      return { text: "仍無法確認款項是否已退回（結果不明）：同單其他退款會繼續等待，請稍後再按「查證並重試」。", isError: true };
    default:
      return { text: "退款尚未完成，請重新整理清單確認進度。", isError: true };
  }
}

/** 重試退款被 RPC 拒絕 → 訊息；`unauthorized` 由頁面另外處理（403）。 */
export function describeRetryFailure(result: { reason: string }): string {
  const messages: Record<string, string> = {
    invalid_input: "輸入有誤，請重新整理後再試",
    refund_not_found: "找不到這筆退款",
    refund_blocked: "同一張訂單有另一筆退款結果不明，須先查證那一筆；請依清單順序處理",
    refund_in_progress: "這筆退款正在處理中（可能有人同時操作），請稍後重新整理",
    payment_unavailable: "付款設定不全，現在無法向閘道送出；請確認 GATEWAY_BASE_URL 與 GATEWAY_API_KEY",
  };
  return Object.hasOwn(messages, result.reason) ? messages[result.reason]! : "操作失敗，請稍後再試";
}

/** 頁面用的結果參數（redirect 後的 query）：只接受已知的狀態。 */
export function parseRetryResult(params: URLSearchParams): string | null {
  const status = params.get("result");
  return status !== null && KNOWN_STATUSES.includes(status) ? status : null;
}
