import { describe, expect, it } from "vitest";
import { addToCart, emptyCart, serializeCart } from "./cart";
import { CART_STORAGE_KEY, loadCart, saveCart, storageOf, type CartStorage } from "./storage";

const fakeStorage = (initial: Record<string, string> = {}) => {
  const data = new Map(Object.entries(initial));
  const storage: CartStorage = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
  };
  return { storage, data };
};

const throwing: CartStorage = {
  getItem: () => {
    throw new DOMException("denied", "SecurityError");
  },
  setItem: () => {
    throw new DOMException("full", "QuotaExceededError");
  },
};

const cart = addToCart(emptyCart, { productId: 1, name: "馬克杯", unitPriceTwd: 320 }, 2);

describe("loadCart / saveCart", () => {
  it("存進去再讀出來得到相同購物車，寫在固定的 key", () => {
    const { storage, data } = fakeStorage();
    expect(saveCart(storage, cart)).toBe(true);
    expect(data.get(CART_STORAGE_KEY)).toBe(serializeCart(cart));
    expect(loadCart(storage)).toEqual(cart);
  });

  it("沒有存過：空購物車", () => {
    expect(loadCart(fakeStorage().storage)).toEqual(emptyCart);
  });

  it("內容損壞：空購物車", () => {
    expect(loadCart(fakeStorage({ [CART_STORAGE_KEY]: "{oops" }).storage)).toEqual(emptyCart);
  });

  it("讀取丟例外：空購物車，不往外丟", () => {
    expect(loadCart(throwing)).toEqual(emptyCart);
  });

  it("寫入丟例外（滿了或被禁用）：回傳 false，不往外丟", () => {
    expect(saveCart(throwing, cart)).toBe(false);
  });

  it("沒有可用的 storage（null）：讀為空購物車、寫回傳 false", () => {
    expect(loadCart(null)).toEqual(emptyCart);
    expect(saveCart(null, cart)).toBe(false);
  });
});

describe("storageOf", () => {
  it("回傳 window 的 localStorage", () => {
    const { storage } = fakeStorage();
    expect(storageOf({ localStorage: storage })).toBe(storage);
  });

  it("存取 localStorage 本身就丟例外（隱私設定）：回傳 null", () => {
    const win = {
      get localStorage(): CartStorage {
        throw new DOMException("denied", "SecurityError");
      },
    };
    expect(storageOf(win)).toBeNull();
  });
});
