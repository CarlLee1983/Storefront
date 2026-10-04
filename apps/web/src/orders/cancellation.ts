import { toNumber, toText } from "../shared/form-values";

const STATUS_LABELS: Record<string, string> = {
  pending: "待審核",
  approved: "已核准",
  rejected: "未獲核准",
};

/** 取消申請進度的顯示名稱；不認得的狀態不顯示原始代碼。 */
export function cancellationStatusLabel(status: string): string {
  return Object.hasOwn(STATUS_LABELS, status) ? STATUS_LABELS[status]! : "狀態待確認";
}

const CUSTOMER_NOTES: Record<string, string> = {
  pending: "審核期間這些商品暫停出貨，仍為你保留。",
  approved: "這些商品不會出貨，保留已釋放；退款另行處理，進度見「退款進度」。",
  rejected: "這些商品照常安排出貨。",
};

export function customerCancellationNote(status: string): string {
  return Object.hasOwn(CUSTOMER_NOTES, status) ? CUSTOMER_NOTES[status]! : "目前無法確認這個申請的進度，請稍後重新整理。";
}

/** 這筆明細還能申請取消的數量：未交運、未被取消申請（待審與核准）占用。 */
export function cancellableQuantity(line: { quantity: number; shippedQuantity: number; cancelledQuantity: number; pendingCancellationQuantity: number }): number {
  return Math.max(0, line.quantity - line.shippedQuantity - line.cancelledQuantity - line.pendingCancellationQuantity);
}

/**
 * 申請取消表單 → RPC 輸入。數量欄位名稱是 `cancel-<訂單明細編號>`，留空或 0 表示不取消該明細；
 * 其餘（負數、超量、非數字）原樣交給 App 驗證。
 */
export function cancellationFormToInput(form: FormData, orderId: number) {
  const items = [...form.entries()].flatMap(([key, value]) => {
    const match = /^cancel-(\d+)$/.exec(key);
    if (!match || toText(value).trim() === "" || toNumber(value) === 0) return [];
    return [{ orderLineId: Number(match[1]), quantity: toNumber(value) }];
  });
  return { orderId, requestKey: toText(form.get("requestKey")), items, reason: toText(form.get("reason")) };
}

/** 申請取消失敗結果 → 頁面上顯示的訊息；`unauthorized` 由頁面另外處理（導去登入）。 */
export function describeCancellationFailure(result: { reason: string; fields?: Record<string, string[]> }) {
  const messages: Record<string, string> = {
    invalid_input: "輸入有誤，請修正後再送出",
    order_not_found: "找不到這張訂單",
    order_not_cancellable: "這張訂單目前不能申請取消（尚未付款、已全數出貨或已取消）",
    cancellation_line_invalid: "選擇的明細不屬於這張訂單，請重新整理後再填",
    cancellation_quantity_exceeded: "數量超過這筆明細還能取消的數量（可能已出貨或已有其他申請），請重新整理後再填",
    request_key_conflict: "這次提交的內容與同一份表單先前送出的不同，請重新整理頁面後再填",
  };
  return { message: messages[result.reason] ?? "申請取消失敗，請稍後再試", fields: result.fields ?? {} };
}
