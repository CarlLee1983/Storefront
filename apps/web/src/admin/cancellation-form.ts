import { toNumber, toText } from "../shared/form-values";

/** 審核表單 → RPC 輸入。`decision` 是按下的按鈕（approve／reject），其餘原樣交給 App 驗證。 */
export function decideFormToInput(form: FormData) {
  return { requestId: toNumber(form.get("requestId")), decision: toText(form.get("decision")), note: toText(form.get("note")) };
}

/** 審核失敗結果 → 頁面上顯示的訊息；`unauthorized` 由頁面另外處理（403）。 */
export function describeDecideFailure(result: { reason: string; fields?: Record<string, string[]> }) {
  const messages: Record<string, string> = {
    invalid_input: "輸入有誤，請修正後再送出",
    cancellation_not_found: "找不到這案取消申請",
    cancellation_already_decided: "這案已經做出相反的決定，請重新整理頁面確認最新狀態",
  };
  return { message: messages[result.reason] ?? "審核失敗，請稍後再試", fields: result.fields ?? {} };
}

/** 審核成功後的提示（redirect 帶回的 `saved` 參數）；不認得的回 null。核准時附上退款目前的進度。 */
export function describeDecideOutcome(saved: string | null, refundStatus: string | null): string | null {
  if (saved === "cancellation-rejected") return "已拒絕這案取消申請，數量恢復可交運，已通知顧客。";
  if (saved !== "cancellation-approved") return null;
  const base = "已核准這案取消申請：停止這些數量的履約並釋放保留，已通知顧客。";
  switch (refundStatus) {
    case "succeeded":
      return `${base}退款已成功退回。`;
    case "failed":
    case "unknown":
    case "pending":
    case "processing":
      return `${base}退款尚未完成（不影響取消結果、也不會恢復出貨），請到退款待辦處理。`;
    default:
      return `${base}退款尚未登記（可退額度被其他退款占用），請查看訂單的退款紀錄。`;
  }
}
