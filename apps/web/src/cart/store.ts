import type { Cart } from "./cart";
import { loadCart, saveCart, type CartStorage } from "./storage";

/** 購物車在本頁被改動；Layout 的件數靠它更新（跨分頁則靠瀏覽器的 storage 事件）。 */
export const CART_CHANGED_EVENT = "storefront:cart-changed";

/** 讀出目前購物車、套用變更、寫回，再通知本頁。saved 為 false 表示沒能存進瀏覽器。 */
export function updateCart(
  storage: CartStorage | null,
  target: EventTarget,
  change: (cart: Cart) => Cart,
): { cart: Cart; saved: boolean } {
  const cart = change(loadCart(storage));
  const saved = saveCart(storage, cart);
  target.dispatchEvent(new Event(CART_CHANGED_EVENT));
  return { cart, saved };
}
