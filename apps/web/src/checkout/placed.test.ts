import { describe, expect, it } from "vitest";
import { PLACED_ORDER_STORAGE_KEY, rememberPlacedOrder, takePlacedOrder, type PlacedStorage } from "./placed";

const fakeStorage = () => {
  const data = new Map<string, string>();
  const storage: PlacedStorage = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
  return { storage, data };
};

const throwing: PlacedStorage = {
  getItem: () => {
    throw new DOMException("denied", "SecurityError");
  },
  setItem: () => {
    throw new DOMException("denied", "SecurityError");
  },
  removeItem: () => {
    throw new DOMException("denied", "SecurityError");
  },
};

describe("takePlacedOrder（只有本次結帳成功的那張訂單才算）", () => {
  it("編號等於記下的訂單：回 true，並移除記錄（只能用一次）", () => {
    const { storage, data } = fakeStorage();
    rememberPlacedOrder(storage, 12);
    expect(data.get(PLACED_ORDER_STORAGE_KEY)).toBe("12");

    expect(takePlacedOrder(storage, 12)).toBe(true);
    expect(data.has(PLACED_ORDER_STORAGE_KEY)).toBe(false);
    expect(takePlacedOrder(storage, 12)).toBe(false);
  });

  it("編號不同（例如手動改網址、看舊訂單）：回 false，記錄保留", () => {
    const { storage, data } = fakeStorage();
    rememberPlacedOrder(storage, 12);

    expect(takePlacedOrder(storage, 7)).toBe(false);
    expect(data.get(PLACED_ORDER_STORAGE_KEY)).toBe("12");
  });

  it("沒有記錄或訂單編號不明：回 false", () => {
    expect(takePlacedOrder(fakeStorage().storage, 12)).toBe(false);
    expect(takePlacedOrder(fakeStorage().storage, null)).toBe(false);
  });

  it("沒有可用的 storage 或存取失敗：不丟例外，回 false", () => {
    expect(() => rememberPlacedOrder(null, 1)).not.toThrow();
    expect(() => rememberPlacedOrder(throwing, 1)).not.toThrow();
    expect(takePlacedOrder(null, 1)).toBe(false);
    expect(takePlacedOrder(throwing, 1)).toBe(false);
  });
});
