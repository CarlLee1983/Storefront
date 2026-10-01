import { MAX_SLUG_LENGTH } from "@storefront/app/category-slug";
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

/** 修改商品表單 → RPC 輸入，含分類下拉選單的值。 */
export function productUpdateFormToInput(form: FormData, id: number) {
  return { id, ...productFormToInput(form), categoryId: categoryIdFromSelect(form.get("categoryId")) };
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
    no_images: "請先上傳商品圖片，再上架商品",
    image_limit: "每件商品最多 8 張商品圖片",
    image_set_changed: "商品圖片清單已變更，請重新載入後再排序",
    last_product_image: "上架中的商品至少需要一張商品圖片，請先下架再刪除",
    image_delete_failed: "商品圖片刪除尚未完成，請重試；系統也會重試清理圖片",
    image_management_failed: "商品圖片操作失敗，請稍後再試",
    image_upload_failed: "商品圖片上傳失敗，請稍後再試",
    no_category: "請先選擇商品分類：上架與重新上架都需要分類，上架中的商品也不能改成未分類",
    category_not_found: "找不到這個分類",
    category_not_empty: "這個分類底下還有商品（不分上架與否），請先把商品移到其他分類再刪除",
    invalid_slug: `代稱只能使用小寫英文、數字與連字號（不可以連字號開頭或結尾），且不可超過 ${MAX_SLUG_LENGTH} 個字元`,
    slug_taken: "這個代稱已被使用，請換一個",
    insufficient_stock: "庫存不足：調整後的可售數量不可為負",
  };
  return { message: messages[result.reason] ?? fallback, fields: result.fields ?? {} };
}
