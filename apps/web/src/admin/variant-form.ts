import { toNumber, toText } from "../shared/form-values";
import { compareAtPriceFromInput, deliveryTypeFromInput, parseProductId, stockAdjustFormToInput } from "./product-form";

/** 變體管理表單的 intent；商品編輯頁的表單用這組值區分要做什麼（沒有 intent 就是儲存商品基本資訊）。 */
export const VARIANT_INTENTS = ["set-options", "create-variant", "update-variant", "discontinue-variant", "resume-variant", "adjust-variant-stock"] as const;

export type VariantFormDispatch =
  | { kind: "set-options"; input: { id: number; optionNames: string[]; defaultVariantValues?: string[] } }
  | { kind: "create-variant"; input: { productId: number; optionValues: string[]; priceTwd: number; compareAtPriceTwd?: number; deliveryType?: string; lowStockThreshold?: number } }
  | { kind: "update-variant"; input: { variantId: number; optionValues: string[]; priceTwd: number; compareAtPriceTwd?: number | null; imageId?: string | null; deliveryType?: string; lowStockThreshold?: number | null } }
  | { kind: "discontinue"; input: { variantId: number; discontinued: boolean } }
  | { kind: "adjust-stock"; input: ReturnType<typeof stockAdjustFormToInput> }
  | { kind: "invalid" };

/** 表單裡有出現的欄位依序取值（出現但留白保留為空字串，由 App 回報錯誤）；欄位根本不存在代表那個維度不存在。 */
function presentValues(form: FormData, names: readonly string[]): string[] {
  return names.filter((name) => form.has(name)).map((name) => toText(form.get(name)));
}

/** 選項名稱：留白的維度不算（兩格都留白就是沒有選項）。 */
function optionNamesFrom(form: FormData): string[] {
  return presentValues(form, ["optionName1", "optionName2"]).map((name) => name.trim()).filter((name) => name !== "");
}

/** 新增變體的原價：留白視為沒有原價（不帶），有值轉成數字。 */
function newVariantCompareAt(value: FormDataEntryValue | null): number | undefined {
  const parsed = compareAtPriceFromInput(value);
  return parsed === null ? undefined : parsed;
}

/** 低庫存門檻：欄位不存在是 `undefined`（不動），留白是 `null`（不提醒），有值轉成數字。 */
function lowStockThresholdFromInput(value: FormDataEntryValue | null): number | null | undefined {
  if (value === null) return undefined;
  return toText(value).trim() === "" ? null : toNumber(value);
}

/**
 * 商品編輯頁的變體管理表單 → RPC 輸入；不判斷內容是否合法，由 App 驗證。
 * 不認得的 intent 或缺少/無效的編號不呼叫任何 RPC。商品編號來自網址，變體編號來自表單。
 */
export function dispatchVariantForm(form: FormData, productId: number): VariantFormDispatch {
  const intent = form.get("intent");
  if (intent === "set-options") {
    const optionNames = optionNamesFrom(form);
    // 頁面永遠顯示兩格預設變體的選項值：只取有對應維度的那幾格，多出來的留白不算
    const defaultVariantValues = presentValues(form, ["defaultValue1", "defaultValue2"]).slice(0, optionNames.length);
    return { kind: "set-options", input: { id: productId, optionNames, ...(defaultVariantValues.length > 0 ? { defaultVariantValues } : {}) } };
  }
  if (intent === "create-variant") {
    const compareAtPriceTwd = newVariantCompareAt(form.get("compareAtPriceTwd"));
    const deliveryType = deliveryTypeFromInput(form.get("deliveryType"));
    const lowStockThreshold = lowStockThresholdFromInput(form.get("lowStockThreshold"));
    return {
      kind: "create-variant",
      input: {
        productId,
        optionValues: presentValues(form, ["value1", "value2"]),
        priceTwd: toNumber(form.get("priceTwd")),
        ...(compareAtPriceTwd === undefined ? {} : { compareAtPriceTwd }),
        ...(deliveryType === undefined ? {} : { deliveryType }),
        ...(lowStockThreshold == null ? {} : { lowStockThreshold }),
      },
    };
  }
  const variantId = parseProductId(toText(form.get("variantId")));
  if (variantId === null) return { kind: "invalid" };
  if (intent === "update-variant") {
    const imageId = form.get("imageId");
    const deliveryType = deliveryTypeFromInput(form.get("deliveryType"));
    const lowStockThreshold = lowStockThresholdFromInput(form.get("lowStockThreshold"));
    return {
      kind: "update-variant",
      input: {
        variantId,
        optionValues: presentValues(form, ["value1", "value2"]),
        priceTwd: toNumber(form.get("priceTwd")),
        compareAtPriceTwd: compareAtPriceFromInput(form.get("compareAtPriceTwd")),
        ...(imageId === null ? {} : { imageId: toText(imageId) === "" ? null : toText(imageId) }),
        ...(deliveryType === undefined ? {} : { deliveryType }),
        ...(lowStockThreshold === undefined ? {} : { lowStockThreshold }),
      },
    };
  }
  if (intent === "discontinue-variant" || intent === "resume-variant") return { kind: "discontinue", input: { variantId, discontinued: intent === "discontinue-variant" } };
  if (intent === "adjust-variant-stock") return { kind: "adjust-stock", input: stockAdjustFormToInput(form, variantId) };
  return { kind: "invalid" };
}
