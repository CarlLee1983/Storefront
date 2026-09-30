import { toNumber, toText } from "../shared/form-values";

/** 新增商品表單 → RPC 輸入；不判斷內容是否合法，由 App 驗證。 */
export function productFormToInput(form: FormData) {
  return {
    name: toText(form.get("name")),
    description: toText(form.get("description")),
    priceTwd: toNumber(form.get("priceTwd")),
  };
}

/** 修改商品表單 → RPC 輸入。 */
export function productUpdateFormToInput(form: FormData, id: number) {
  return { id, ...productFormToInput(form) };
}

/** 網址上的商品編號；不是正整數就回傳 null（頁面顯示找不到）。 */
export function parseProductId(value: string | undefined): number | null {
  return value !== undefined && /^[1-9]\d*$/.test(value) ? Number(value) : null;
}

export type ListingAction = "unlist" | "relist";

export type ProductFormDispatch =
  | { kind: "create" }
  | { kind: "listing"; action: ListingAction; id: number }
  | { kind: "invalid" };

/**
 * 後台清單頁 POST 的分派：沒有 `intent` 欄位才是新增；有 `intent` 就必須是合法的下架／重新上架，
 * 否則是 invalid（頁面不呼叫任何 RPC），避免被竄改的表單落到新增。
 */
export function dispatchProductForm(form: FormData): ProductFormDispatch {
  const intent = form.get("intent");
  if (intent === null) return { kind: "create" };
  const id = parseProductId(toText(form.get("id")));
  if ((intent !== "unlist" && intent !== "relist") || id === null) return { kind: "invalid" };
  return { kind: "listing", action: intent, id };
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

/**
 * 把管理 RPC 的失敗結果轉成表單上顯示的訊息；`unauthorized` 由頁面另外處理（403）。
 * `fallback` 是沒有專屬訊息的原因所用的預設訊息。
 */
export function describeFailure(
  result: { reason: string; fields?: Record<string, string[]> },
  fallback: string,
): Failure {
  const messages: Record<string, string> = {
    invalid_input: "輸入有誤，請修正後再送出",
    product_not_found: "找不到這個商品",
  };
  return { message: messages[result.reason] ?? fallback, fields: result.fields ?? {} };
}
