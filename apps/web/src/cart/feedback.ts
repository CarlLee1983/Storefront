import { isValidQuantity, type Cart } from "./cart";

export const INVALID_QUANTITY_MESSAGE = "請輸入 1 以上的整數。";

/** 購物車的變更沒能寫進瀏覽器（容量滿、被禁用）；加入與改數量共用。 */
export const SAVE_FAILED_MESSAGE = "購物車的變更未能儲存，請檢查瀏覽器的儲存設定後再試。";

/**
 * 「加入購物車」後給顧客看的提示。數量無效時直接回錯誤，不執行 `add`（不碰購物車）；
 * 有執行時依結果判斷：沒存成功、商品被拒絕（車內找不到該商品）、或成功。
 */
export function addFeedback(
  quantity: number,
  variantId: number,
  add: () => { cart: Cart; saved: boolean },
): string {
  if (!isValidQuantity(quantity)) return INVALID_QUANTITY_MESSAGE;
  const { cart, saved } = add();
  if (!saved) return SAVE_FAILED_MESSAGE;
  const line = cart.lines.find((l) => l.variantId === variantId);
  return line ? `已加入購物車，目前 ${line.quantity} 件。` : "目前無法加入這件商品，請重新整理後再試。";
}
