import { MAX_SLUG_LENGTH } from "@storefront/app/category-slug";

export interface Failure {
  message: string;
  /** 欄位名稱 → 錯誤訊息（訊息由 App 的驗證產生，已是可顯示的文字）。 */
  fields: Record<string, string[]>;
}

/** 訊息本身已是可直接顯示給管理員的文字；其他例外一律當成非預期錯誤，只顯示通用訊息。 */
export class UserFacingError extends Error {}

/**
 * 把管理 RPC 的失敗結果轉成表單上顯示的訊息；`unauthorized` 由頁面另外處理（403）。
 * `fallback` 是沒有專屬訊息的原因所用的預設訊息；`imageLabel` 是圖片上傳失敗訊息裡的對象（商品圖片或分類圖片）。
 */
export function describeFailure(
  result: { reason: string; fields?: Record<string, string[]> },
  fallback: string,
  imageLabel = "商品圖片",
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
    image_upload_failed: `${imageLabel}上傳失敗，請稍後再試`,
    no_category: "請先選擇商品分類：上架與重新上架都需要分類，上架中的商品也不能改成未分類",
    category_not_found: "找不到這個分類",
    category_not_empty: "這個分類底下還有商品（不分上架與否），請先把商品移到其他分類再刪除",
    invalid_slug: `代稱只能使用小寫英文、數字與連字號（不可以連字號開頭或結尾），且不可超過 ${MAX_SLUG_LENGTH} 個字元`,
    slug_taken: "這個代稱已被使用，請換一個",
    insufficient_stock: "庫存不足：調整後的可售數量不可為負",
  };
  return { message: messages[result.reason] ?? fallback, fields: result.fields ?? {} };
}

/** 頁面呼叫 RPC 拋出例外時：詳細原因只進 log，使用者看到通用訊息。 */
export function logFailure(event: string, cause: unknown): void {
  console.error(JSON.stringify({ event, error: cause instanceof Error ? cause.message : String(cause) }));
}
