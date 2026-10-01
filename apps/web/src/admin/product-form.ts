import { toNumber, toText } from "../shared/form-values";
import { categoryFormToInput, categoryIdFromSelect } from "./category-form";

/** 新增商品表單 → RPC 輸入；不判斷內容是否合法，由 App 驗證。 */
export function productFormToInput(form: FormData) {
  return {
    name: toText(form.get("name")),
    description: toText(form.get("description")),
    priceTwd: toNumber(form.get("priceTwd")),
  };
}

/**
 * 原價欄位：有值是數字、留空是 `null`（清空原價，結束特價）、欄位不存在是 `undefined`（不動原價）。
 * 非數字轉成 NaN，讓 App 回報錯誤。
 */
export function compareAtPriceFromInput(value: FormDataEntryValue | null): number | null | undefined {
  if (value === null) return undefined;
  return toText(value).trim() === "" ? null : toNumber(value);
}

/** 修改商品表單 → RPC 輸入，含分類下拉選單與原價欄位的值。 */
export function productUpdateFormToInput(form: FormData, id: number) {
  return {
    id,
    ...productFormToInput(form),
    compareAtPriceTwd: compareAtPriceFromInput(form.get("compareAtPriceTwd")),
    categoryId: categoryIdFromSelect(form.get("categoryId")),
  };
}

/** 庫存調整表單 → RPC 輸入；增減量（+20、-3）轉成數字，是否合法由 App 驗證。 */
export function stockAdjustFormToInput(form: FormData, id: number) {
  return { id, delta: toNumber(form.get("delta")) };
}

/** 網址上的商品編號；不是正整數就回傳 null（頁面顯示找不到）。 */
export function parseProductId(value: string | undefined): number | null {
  return value !== undefined && /^[1-9]\d*$/.test(value) ? Number(value) : null;
}

export type ListingAction = "unlist" | "relist";

export type ProductFormDispatch =
  | { kind: "create" }
  | { kind: "listing"; action: ListingAction; id: number }
  | { kind: "stock"; input: ReturnType<typeof stockAdjustFormToInput> }
  | { kind: "create-category"; input: ReturnType<typeof categoryFormToInput> }
  | { kind: "invalid" };

/**
 * 後台清單頁 POST 的分派：沒有 `intent` 欄位才是新增；有 `intent` 就必須是合法的下架／重新上架／庫存調整／建立分類，
 * 否則是 invalid（頁面不呼叫任何 RPC），避免被竄改的表單落到新增。
 */
export function dispatchProductForm(form: FormData): ProductFormDispatch {
  const intent = form.get("intent");
  if (intent === null) return { kind: "create" };
  if (intent === "create-category") return { kind: "create-category", input: categoryFormToInput(form) };
  const id = parseProductId(toText(form.get("id")));
  if (id === null) return { kind: "invalid" };
  if (intent === "adjust-stock") return { kind: "stock", input: stockAdjustFormToInput(form, id) };
  if (intent !== "unlist" && intent !== "relist") return { kind: "invalid" };
  return { kind: "listing", action: intent, id };
}
