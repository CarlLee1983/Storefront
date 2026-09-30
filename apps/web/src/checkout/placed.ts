export const PLACED_ORDER_STORAGE_KEY = "storefront.placed-order";

/** 只用到 Storage 的這三個方法，測試可以用假物件。 */
export type PlacedStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** 結帳成功：記下這次成立的訂單編號，讓訂單頁確認「剛結帳成功的就是這張」才清空購物車。存取失敗不丟例外。 */
export function rememberPlacedOrder(storage: PlacedStorage | null, orderId: number): void {
  try {
    storage?.setItem(PLACED_ORDER_STORAGE_KEY, String(orderId));
  } catch {
    // 存不了就不會清購物車：寧可讓顧客自己清，也不因為網址參數就清掉別的內容
  }
}

/**
 * 訂單頁用：只有 `orderId` 等於記下的那張才回 true，並移除記錄（只能用一次）。
 * 光是網址帶 `?placed=1` 不算數（手動輸入、書籤、看舊訂單都不會清購物車）。
 */
export function takePlacedOrder(storage: PlacedStorage | null, orderId: number | null): boolean {
  try {
    if (orderId === null || storage?.getItem(PLACED_ORDER_STORAGE_KEY) !== String(orderId)) return false;
    storage.removeItem(PLACED_ORDER_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}
