import { toNumber, toText } from "../shared/form-values";

/** 新增商品表單 → RPC 輸入；不判斷內容是否合法，由 App 驗證。 */
export function productFormToInput(form: FormData) {
  return {
    name: toText(form.get("name")),
    description: toText(form.get("description")),
    priceTwd: toNumber(form.get("priceTwd")),
  };
}

/** 表單目前的欄位值，驗證失敗時回填。 */
export function formToRecord(form: FormData): Record<string, string> {
  return Object.fromEntries([...form.entries()].map(([key, value]) => [key, toText(value)]));
}

export interface Failure {
  message: string;
  /** 欄位名稱 → 錯誤訊息（訊息由 App 的驗證產生，已是可顯示的文字）。 */
  fields: Record<string, string[]>;
}

/** 把管理 RPC 的失敗結果轉成表單上顯示的訊息；`unauthorized` 由頁面另外處理（403）。 */
export function describeCreateFailure(result: { reason: string; fields?: Record<string, string[]> }): Failure {
  return {
    message: result.reason === "invalid_input" ? "輸入有誤，請修正後再送出" : "新增商品失敗，請稍後再試",
    fields: result.fields ?? {},
  };
}
