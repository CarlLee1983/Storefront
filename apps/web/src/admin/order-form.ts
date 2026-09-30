import { ORDER_STATUS_CODES } from "../orders/labels";
import { toText } from "../shared/form-values";

/** 網址上的狀態篩選（`?status=paid`）；不是五種訂單狀態之一就視為不篩選，不呼叫 App 去驗。 */
export function parseStatusFilter(value: string | null): string | undefined {
  return value !== null && ORDER_STATUS_CODES.includes(value) ? value : undefined;
}

/** 出貨表單 → RPC 輸入；物流單號可以留空，trim 與長度由 App 驗證。 */
export function shipFormToInput(form: FormData, orderId: number) {
  return { orderId, trackingNumber: toText(form.get("trackingNumber")) };
}

/** 出貨失敗結果 → 頁面上顯示的訊息；`unauthorized` 由頁面另外處理（403）。 */
export function describeShipFailure(result: { reason: string; fields?: Record<string, string[]> }) {
  const messages: Record<string, string> = {
    invalid_input: "輸入有誤，請修正後再送出",
    order_not_found: "找不到這張訂單",
    order_not_shippable: "這張訂單目前不是已付款，不能出貨（可能已出貨或已被處理）",
  };
  return { message: messages[result.reason] ?? "出貨失敗，請稍後再試", fields: result.fields ?? {} };
}
