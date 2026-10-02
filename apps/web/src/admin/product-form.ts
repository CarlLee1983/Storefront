import { toNumber, toText } from "../shared/form-values";
import { categoryIdFromSelect } from "./category-form";

/** 配送類型欄位：欄位不存在是 `undefined`（新增時用預設、修改時不動），存在則原樣交給 App 驗證。 */
export function deliveryTypeFromInput(value: FormDataEntryValue | null): string | undefined {
  return value === null ? undefined : toText(value);
}

/** 新增商品表單 → RPC 輸入；不判斷內容是否合法，由 App 驗證。 */
export function productFormToInput(form: FormData) {
  const deliveryType = deliveryTypeFromInput(form.get("deliveryType"));
  return {
    name: toText(form.get("name")),
    description: toText(form.get("description")),
    priceTwd: toNumber(form.get("priceTwd")),
    ...(deliveryType === undefined ? {} : { deliveryType }),
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

/** 欄位不存在是 `undefined`（不動），存在則為文字（留空即清空）。 */
function optionalText(value: FormDataEntryValue | null): string | undefined {
  return value === null ? undefined : toText(value);
}

/** 修改商品表單 → RPC 輸入，含分類下拉選單與原價欄位的值。 */
export function productUpdateFormToInput(form: FormData, id: number) {
  return {
    id,
    ...productFormToInput(form),
    compareAtPriceTwd: compareAtPriceFromInput(form.get("compareAtPriceTwd")),
    categoryId: categoryIdFromSelect(form.get("categoryId")),
    dimensions: optionalText(form.get("dimensions")),
    material: optionalText(form.get("material")),
    care: optionalText(form.get("care")),
  };
}

/** 庫存調整表單 → RPC 輸入；庫存以商品變體為單位，增減量（+20、-3）轉成數字，是否合法由 App 驗證。 */
export function stockAdjustFormToInput(form: FormData, variantId: number) {
  return { variantId, delta: toNumber(form.get("delta")) };
}

/** 網址上的商品編號與表單上的編號；不是正整數就回傳 null（頁面顯示找不到）。 */
export function parseProductId(value: string | undefined): number | null {
  return value !== undefined && /^[1-9]\d*$/.test(value) ? Number(value) : null;
}

/** 清單上精選切換表單的 intent；後台頁面的表單與儲存後的提示也用同一組值。 */
export const FEATURE_INTENT = "feature";
export const UNFEATURE_INTENT = "unfeature";

export type ListingAction = "unlist" | "relist";

export type ProductFormDispatch =
  | { kind: "listing"; action: ListingAction; id: number }
  | { kind: "featured"; featured: boolean; id: number }
  | { kind: "stock"; input: ReturnType<typeof stockAdjustFormToInput> }
  | { kind: "invalid" };

/**
 * 後台清單頁只接受明確的清單操作；新增商品由獨立路由處理。
 * 不認得或缺少 intent 時不呼叫任何變更 RPC。
 */
export function dispatchProductForm(form: FormData): ProductFormDispatch {
  const intent = form.get("intent");
  if (intent === null) return { kind: "invalid" };
  if (intent === "adjust-stock") {
    const variantId = parseProductId(toText(form.get("variantId")));
    return variantId === null ? { kind: "invalid" } : { kind: "stock", input: stockAdjustFormToInput(form, variantId) };
  }
  const id = parseProductId(toText(form.get("id")));
  if (id === null) return { kind: "invalid" };
  if (intent === FEATURE_INTENT || intent === UNFEATURE_INTENT) return { kind: "featured", featured: intent === FEATURE_INTENT, id };
  if (intent !== "unlist" && intent !== "relist") return { kind: "invalid" };
  return { kind: "listing", action: intent, id };
}
