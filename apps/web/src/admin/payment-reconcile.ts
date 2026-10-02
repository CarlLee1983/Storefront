import { RECONCILE_ISSUE_REASONS, type ReconcileIssueReason } from "@storefront/app/payments-shared";

const ISSUE_LABELS: Record<ReconcileIssueReason, string> = {
  gateway_unavailable: "查不到金流閘道的結果（連不上或回應異常）",
  gateway_mismatch: "閘道回的金額或訂單參照與本站記錄不符",
  result_unclear: "閘道回的結果無法套用（沒有事件 ID，或狀態與本站不一致）",
};

const ISSUE_ADVICE: Record<ReconcileIssueReason, string> = {
  gateway_unavailable: "稍後再按「補查」；Cron 每分鐘也會自動重試。持續失敗請檢查金流閘道是否正常。",
  gateway_mismatch: "不會自動套用。請到閘道主控頁核對這筆付款的金額與商家參照，確認後再通知工程人員處理。",
  result_unclear: "不會自動套用。請到閘道主控頁確認這筆付款的實際狀態，再按「補查」或通知工程人員處理。",
};

export function reconcileIssueLabel(reason: ReconcileIssueReason): string {
  return ISSUE_LABELS[reason];
}

export function reconcileIssueAdvice(reason: ReconcileIssueReason): string {
  return ISSUE_ADVICE[reason];
}

/** 觸發者：`cron` 顯示為「系統排程」，其餘是管理員 email。 */
export function reconcileSourceLabel(source: string): string {
  return source === "cron" ? "系統排程" : source;
}

/** 補查 RPC 的結果 → 頁面上的提示；`issue` 要帶原因。 */
export function describeReconcileOutcome(outcome: string, reason?: string | null): { text: string; isError: boolean } {
  switch (outcome) {
    case "settled":
      return { text: "已補查並套用閘道的付款結果，訂單進度與通知已補齊。", isError: false };
    case "expired":
      return { text: "閘道端這筆付款已失效，本站已同步記為已失效。", isError: false };
    case "waiting":
      return { text: "閘道端這筆付款還沒有結果（顧客可能尚未付款），暫不需處理。", isError: false };
    case "issue":
      return {
        text: `補查沒能確認結果：${isIssueReason(reason) ? ISSUE_LABELS[reason] : "原因不明"}。已記在待辦。`,
        isError: true,
      };
    default:
      return { text: "操作失敗，請稍後再試。", isError: true };
  }
}

function isIssueReason(value: string | null | undefined): value is ReconcileIssueReason {
  return (RECONCILE_ISSUE_REASONS as readonly string[]).includes(value ?? "");
}

/** 管理端補查失敗（RPC 拒絕）→ 訊息；`unauthorized` 由頁面另外處理（403）。 */
export function describeReconcileFailure(result: { reason: string }): string {
  const messages: Record<string, string> = {
    invalid_input: "輸入有誤，請重新整理後再試",
    payment_not_found: "找不到這筆付款",
    payment_not_pending: "這筆付款已經有結果，不需要補查；請重新整理清單",
    payment_unavailable: "付款設定不全，現在無法向閘道查詢；請確認 GATEWAY_BASE_URL 與 GATEWAY_API_KEY",
  };
  return Object.hasOwn(messages, result.reason) ? messages[result.reason]! : "操作失敗，請稍後再試";
}

/** 頁面用的結果參數（redirect 後的 query）：只接受已知的結果與原因。 */
export function parseReconcileResult(params: URLSearchParams): { outcome: string; reason: string | null } | null {
  const outcome = params.get("result");
  if (outcome === null || !["settled", "expired", "waiting", "issue"].includes(outcome)) return null;
  const reason = params.get("reason");
  return { outcome, reason: isIssueReason(reason) ? reason : null };
}
