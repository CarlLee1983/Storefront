import { ORDER_STATUS_CODES } from "../orders/labels";
import { toNumber, toText } from "../shared/form-values";

/** 網址上的狀態篩選（`?status=paid`）；不是六種訂單狀態之一就視為不篩選，不呼叫 App 去驗。 */
export function parseStatusFilter(value: string | null): string | undefined {
  return value !== null && ORDER_STATUS_CODES.includes(value) ? value : undefined;
}

/** 瀏覽器 `datetime-local` 的值（`2026-10-10T09:00`，台北時間）→ UTC epoch 毫秒；留空為 undefined，格式不對為 NaN（交給 App 回報欄位錯誤）。 */
function taipeiLocalToEpoch(value: unknown): number | undefined {
  const text = toText(value).trim();
  if (text === "") return undefined;
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(text) ? Date.parse(`${text}:00+08:00`) : Number.NaN;
}

/**
 * 交運表單 → RPC 輸入。數量欄位名稱是 `quantity-<訂單明細編號>`，留空或 0 表示這批不含該明細；
 * 其餘（負數、超量、非數字）原樣交給 App 驗證。議定時段兩欄都留空表示沒有。
 */
export function shipFormToInput(form: FormData, orderId: number) {
  const items = [...form.entries()].flatMap(([key, value]) => {
    const match = /^quantity-(\d+)$/.exec(key);
    if (!match || toText(value).trim() === "" || toNumber(value) === 0) return [];
    return [{ orderLineId: Number(match[1]), quantity: toNumber(value) }];
  });
  const start = taipeiLocalToEpoch(form.get("appointmentStart"));
  const end = taipeiLocalToEpoch(form.get("appointmentEnd"));
  return {
    orderId,
    dispatchKey: toText(form.get("dispatchKey")),
    items,
    trackingNumber: toText(form.get("trackingNumber")),
    appointment: start === undefined && end === undefined ? undefined : { start: start ?? Number.NaN, end: end ?? Number.NaN },
  };
}

/** 交運失敗結果 → 頁面上顯示的訊息；`unauthorized` 由頁面另外處理（403）。 */
export function describeShipFailure(result: { reason: string; fields?: Record<string, string[]> }) {
  const messages: Record<string, string> = {
    invalid_input: "輸入有誤，請修正後再送出",
    order_not_found: "找不到這張訂單",
    order_not_shippable: "這張訂單目前不是已付款或部分出貨，不能交運（可能已全數出貨或已被處理）",
    shipment_line_invalid: "交運的明細不屬於這張訂單，請重新整理後再填",
    shipment_quantity_exceeded: "數量超過這筆明細尚未交運的數量（可能剛有另一批交運），請重新整理後再填",
    dispatch_key_conflict: "這次提交的內容與同一份表單先前送出的不同，請重新整理頁面後再填",
    appointment_required: "含大型配送商品的批次必須填寫與顧客議定的配送時段",
    appointment_not_applicable: "只有一般宅配商品的批次不需要配送時段，請清空時段欄位",
  };
  return { message: messages[result.reason] ?? "交運失敗，請稍後再試", fields: result.fields ?? {} };
}
