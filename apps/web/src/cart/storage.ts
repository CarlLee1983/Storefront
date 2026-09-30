import { deserializeCart, emptyCart, serializeCart, type Cart } from "./cart";

export const CART_STORAGE_KEY = "storefront.cart";

/** 只用到 Storage 的這兩個方法，測試可以用假物件。 */
export type CartStorage = Pick<Storage, "getItem" | "setItem">;

/** 取得瀏覽器的 localStorage；隱私設定可能讓存取本身丟例外，此時回傳 null。 */
export function storageOf(win: { localStorage: CartStorage }): CartStorage | null {
  try {
    return win.localStorage;
  } catch {
    return null;
  }
}

/** 讀不到、讀取失敗或內容不可用，一律當作空購物車。 */
export function loadCart(storage: CartStorage | null): Cart {
  try {
    return deserializeCart(storage?.getItem(CART_STORAGE_KEY) ?? null);
  } catch {
    return emptyCart;
  }
}

/** 寫入是否成功；失敗（容量滿、被禁用）不丟例外，由呼叫端決定是否提示顧客。 */
export function saveCart(storage: CartStorage | null, cart: Cart): boolean {
  try {
    if (!storage) return false;
    storage.setItem(CART_STORAGE_KEY, serializeCart(cart));
    return true;
  } catch {
    return false;
  }
}
