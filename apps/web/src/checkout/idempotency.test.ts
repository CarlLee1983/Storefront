import { describe, expect, it } from "vitest";
import { CHECKOUT_KEY_STORAGE_KEY, clearIdempotencyKey, getOrCreateIdempotencyKey, type KeyStorage } from "./idempotency";

const fakeStorage = () => {
  const data = new Map<string, string>();
  const storage: KeyStorage = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
  return { storage, data };
};

const throwing: KeyStorage = {
  getItem: () => {
    throw new DOMException("denied", "SecurityError");
  },
  setItem: () => {
    throw new DOMException("full", "QuotaExceededError");
  },
  removeItem: () => {
    throw new DOMException("denied", "SecurityError");
  },
};

describe("getOrCreateIdempotencyKey", () => {
  it("第一次產生並連同內容指紋存起來，同一次結帳（內容相同）重送沿用同一個鍵", () => {
    const { storage, data } = fakeStorage();
    let n = 0;
    const generate = () => `key-${(n += 1)}`;

    expect(getOrCreateIdempotencyKey(storage, generate, "內容 A")).toBe("key-1");
    expect(getOrCreateIdempotencyKey(storage, generate, "內容 A")).toBe("key-1");
    expect(JSON.parse(data.get(CHECKOUT_KEY_STORAGE_KEY)!)).toEqual({ key: "key-1", fingerprint: "內容 A" });
  });

  it("購物車或收件資訊改變（指紋不同）就換一把新的鍵，之後同內容再沿用新鍵", () => {
    const { storage } = fakeStorage();
    let n = 0;
    const generate = () => `key-${(n += 1)}`;
    getOrCreateIdempotencyKey(storage, generate, "內容 A");

    expect(getOrCreateIdempotencyKey(storage, generate, "內容 B")).toBe("key-2");
    expect(getOrCreateIdempotencyKey(storage, generate, "內容 B")).toBe("key-2");
  });

  it("存的內容不可用（壞掉的 JSON、形狀不對）就當作沒有，產生新鍵", () => {
    const { storage, data } = fakeStorage();
    data.set(CHECKOUT_KEY_STORAGE_KEY, "{oops");
    expect(getOrCreateIdempotencyKey(storage, () => "fresh", "x")).toBe("fresh");
    data.set(CHECKOUT_KEY_STORAGE_KEY, JSON.stringify({ key: 5 }));
    expect(getOrCreateIdempotencyKey(storage, () => "fresh-2", "x")).toBe("fresh-2");
  });

  it("清掉之後（結帳成功）下一次結帳是新的鍵", () => {
    const { storage } = fakeStorage();
    let n = 0;
    const generate = () => `key-${(n += 1)}`;
    getOrCreateIdempotencyKey(storage, generate, "內容 A");

    clearIdempotencyKey(storage);

    expect(getOrCreateIdempotencyKey(storage, generate, "內容 A")).toBe("key-2");
  });

  it("沒有可用的 storage 或存取失敗：仍回傳一個新鍵，不丟例外", () => {
    expect(getOrCreateIdempotencyKey(null, () => "fresh", "x")).toBe("fresh");
    expect(getOrCreateIdempotencyKey(throwing, () => "fresh", "x")).toBe("fresh");
    expect(() => clearIdempotencyKey(null)).not.toThrow();
    expect(() => clearIdempotencyKey(throwing)).not.toThrow();
  });
});
