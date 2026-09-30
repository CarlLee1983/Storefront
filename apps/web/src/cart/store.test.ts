import { describe, expect, it, vi } from "vitest";
import { addToCart, type Cart } from "./cart";
import { CART_CHANGED_EVENT, updateCart } from "./store";
import type { CartStorage } from "./storage";

const memoryStorage = (): CartStorage => {
  let value: string | null = null;
  return { getItem: () => value, setItem: (_key, v) => void (value = v) };
};

const mug = { productId: 1, name: "馬克杯", unitPriceTwd: 320 };
const add = (n: number) => (cart: Cart) => addToCart(cart, mug, n);

describe("updateCart", () => {
  it("讀出目前購物車、套用變更、寫回，並回傳新內容", () => {
    const storage = memoryStorage();
    updateCart(storage, new EventTarget(), add(2));
    const result = updateCart(storage, new EventTarget(), add(3));
    expect(result.saved).toBe(true);
    expect(result.cart.lines[0]?.quantity).toBe(5);
  });

  it("變更後通知同頁的其他元件（Layout 的件數）", () => {
    const target = new EventTarget();
    const listener = vi.fn();
    target.addEventListener(CART_CHANGED_EVENT, listener);
    updateCart(memoryStorage(), target, add(1));
    expect(listener).toHaveBeenCalledOnce();
  });

  it("寫入失敗：saved 為 false，仍回傳套用後的購物車供畫面顯示", () => {
    const failing: CartStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("full");
      },
    };
    const result = updateCart(failing, new EventTarget(), add(1));
    expect(result.saved).toBe(false);
    expect(result.cart.lines).toHaveLength(1);
  });
});
