import { addToCart, isValidQuantity, MAX_QUANTITY, removeFromCart, setQuantity, type Cart, type CartItem } from "./cart";
import { fetchAvailability, purchaseLimit, remainingToAdd, STOCK_ERROR, type Availability } from "./availability";
import { INVALID_QUANTITY_MESSAGE, SAVE_FAILED_MESSAGE } from "./feedback";
import { loadCart, storageOf } from "./storage";
import { updateCart } from "./store";

export interface PurchaseResult { ok: boolean; message: string; cart: Cart; availability?: Availability | null }

/** 所有數量寫入共用跨分頁鎖；鎖內重讀，再同步判斷和寫入，避免兩次加入覆蓋彼此。 */
async function mutate(change: (cart: Cart) => { cart: Cart; message: string }): Promise<PurchaseResult> {
  const apply = () => {
    const storage = storageOf(window);
    const current = loadCart(storage);
    const result = change(current);
    if (result.cart === current) return { ok: false, message: result.message, cart: current };
    const saved = updateCart(storage, window, () => result.cart);
    return { ok: saved.saved, message: saved.saved ? result.message : SAVE_FAILED_MESSAGE, cart: saved.saved ? saved.cart : current };
  };
  // 不支援 Web Locks 的瀏覽器仍在單一同步區段判斷／寫入；後端維持原子庫存檢查。
  return navigator.locks ? navigator.locks.request("storefront.cart", apply) : apply();
}

export async function addAvailableItem(item: CartItem, quantity: number): Promise<PurchaseResult> {
  if (!isValidQuantity(quantity)) return { ok: false, message: INVALID_QUANTITY_MESSAGE, cart: loadCart(storageOf(window)) };
  const stock = await fetchAvailability([item.variantId]);
  const result = await mutate(cart => {
    if (!stock) return { cart, message: STOCK_ERROR };
    const available = stock.get(item.variantId);
    if (available === undefined) return { cart, message: "目前無法購買這件商品。" };
    const remaining = remainingToAdd(cart, item.variantId, available);
    if (quantity > remaining) {
      const existing = cart.lines.find(line => line.variantId === item.variantId)?.quantity ?? 0;
      return { cart, message: `購物車已有 ${existing} 件，最多還能加入 ${remaining} 件。` };
    }
    const next = addToCart(cart, item, quantity, available);
    return { cart: next, message: next === cart ? "目前無法加入這件商品，請重新整理後再試。" : `已加入購物車，目前 ${next.lines.find(line => line.variantId === item.variantId)!.quantity} 件。` };
  });
  return { ...result, availability: stock };
}

/** 減量不需網路；增加時查詢後仍須確認原列未被改動，避免舊操作蓋掉新的操作。 */
export async function changeAvailableQuantity(variantId: number, quantity: number): Promise<PurchaseResult> {
  const before = loadCart(storageOf(window));
  const previous = before.lines.find(line => line.variantId === variantId)?.quantity;
  if (!isValidQuantity(quantity) || quantity > MAX_QUANTITY) return { ok: false, message: `請輸入 1 到 ${MAX_QUANTITY} 的整數。`, cart: before };
  const increasing = previous !== undefined && quantity > previous;
  const stock = increasing ? await fetchAvailability([variantId]) : null;
  return mutate(cart => {
    const line = cart.lines.find(line => line.variantId === variantId);
    if (!line || line.quantity !== previous) return { cart, message: "購物車已更新，請重新調整數量。" };
    if (increasing) {
      if (!stock) return { cart, message: STOCK_ERROR };
      const available = stock.get(variantId);
      if (available === undefined) return { cart, message: "目前無法購買這件商品。" };
      if (quantity > purchaseLimit(available)) return { cart, message: `目前僅可購買 ${purchaseLimit(available)} 件，請調整數量。` };
    }
    return { cart: setQuantity(cart, variantId, quantity), message: "" };
  });
}

export const removeAvailableItem = (variantId: number) => mutate(cart => ({ cart: removeFromCart(cart, variantId), message: "" }));
