import { toNumber, toText } from "../shared/form-values";

const STATUS_LABELS: Record<string, string> = {
  pending: "待審核",
  approved: "已核准，等待收回",
  rejected: "未獲核准",
  received: "已收到，檢查中",
  not_received: "未收到商品，已結案",
  completed: "已檢查完成",
};

/** 退貨申請進度的顯示名稱；不認得的狀態不顯示原始代碼。 */
export function returnStatusLabel(status: string): string {
  return Object.hasOwn(STATUS_LABELS, status) ? STATUS_LABELS[status]! : "狀態待確認";
}

const CUSTOMER_NOTES: Record<string, string> = {
  pending: "我們正在審核這個退貨申請，結果會通知你。",
  approved: "已核准：請依客服指示寄回商品，收回運費由商家負擔。我們收到並檢查後才會退款。",
  rejected: "這個申請未獲核准，商品不需寄回；如有疑問請聯絡客服。",
  received: "我們已收到退回的商品，正在檢查，完成後會依原實付單價退款。",
  not_received: "我們沒有收到這個申請的商品，申請已結案；如已寄出請聯絡客服。",
  completed: "已檢查完成並依原實付單價辦理退款；退款進度見「退款進度」。",
};

export function customerReturnNote(status: string): string {
  return Object.hasOwn(CUSTOMER_NOTES, status) ? CUSTOMER_NOTES[status]! : "目前無法確認這個申請的進度，請稍後重新整理。";
}

/** 這筆明細還能申請退貨的數量：已交運、未被退貨申請占用（進行中與已退貨）。 */
export function returnableQuantity(line: { shippedQuantity: number; returnedQuantity: number; openReturnQuantity: number }): number {
  return Math.max(0, line.shippedQuantity - line.returnedQuantity - line.openReturnQuantity);
}

/**
 * 申請退貨表單 → RPC 輸入。數量欄位名稱是 `return-<訂單明細編號>`，留空或 0 表示不退該明細；
 * 其餘（負數、超量、非數字）原樣交給 App 驗證。
 */
export function returnFormToInput(form: FormData, orderId: number) {
  const items = [...form.entries()].flatMap(([key, value]) => {
    const match = /^return-(\d+)$/.exec(key);
    if (!match || toText(value).trim() === "" || toNumber(value) === 0) return [];
    return [{ orderLineId: Number(match[1]), quantity: toNumber(value) }];
  });
  return { orderId, requestKey: toText(form.get("requestKey")), items, reason: toText(form.get("reason")) };
}

/** 申請退貨失敗結果 → 頁面上顯示的訊息；`unauthorized` 由頁面另外處理（導去登入）。 */
export function describeReturnRequestFailure(result: { reason: string; fields?: Record<string, string[]> }) {
  const messages: Record<string, string> = {
    invalid_input: "輸入有誤，請修正後再送出",
    order_not_found: "找不到這張訂單",
    order_not_returnable: "這張訂單目前沒有已出貨的商品可以退貨",
    return_line_invalid: "選擇的明細不屬於這張訂單，請重新整理後再填",
    return_quantity_exceeded: "數量超過這筆明細還能退貨的數量（可能已有其他申請或已退過），請重新整理後再填",
    request_key_conflict: "這次提交的內容與同一份表單先前送出的不同，請重新整理頁面後再填",
  };
  return { message: messages[result.reason] ?? "申請退貨失敗，請稍後再試", fields: result.fields ?? {} };
}
