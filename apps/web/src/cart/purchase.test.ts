import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addToCart, cartCount, emptyCart, serializeCart, type Cart } from "./cart";
import { STOCK_ERROR } from "./availability";
import { SAVE_FAILED_MESSAGE } from "./feedback";
import { addAvailableItem, changeAvailableQuantity, removeAvailableItem } from "./purchase";
import { CART_STORAGE_KEY, loadCart, type CartStorage } from "./storage";
import { CART_CHANGED_EVENT } from "./store";

const item = { variantId: 1, productId: 1, name: "馬克杯", unitPriceTwd: 320 };
const newPrice = { ...item, name: "新版馬克杯", unitPriceTwd: 999 };
let storage: CartStorage;
let fetcher: ReturnType<typeof vi.fn>;
let changed: ReturnType<typeof vi.fn<() => void>>;

const available = (count: number) => ({ ok: true, json: async () => ({ variants: [{ variantId: 1, available: count }] }) }) as Response;
const seed = (cart: Cart) => storage.setItem(CART_STORAGE_KEY, serializeCart(cart));
const saved = () => loadCart(storage);

beforeEach(() => {
  const values = new Map<string, string>();
  storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } };
  const win = new EventTarget();
  Object.defineProperty(win, "localStorage", { get: () => storage });
  changed = vi.fn();
  win.addEventListener(CART_CHANGED_EVENT, changed);
  vi.stubGlobal("window", win);
  vi.stubGlobal("navigator", { locks: undefined });
  fetcher = vi.fn().mockResolvedValue(available(10));
  vi.stubGlobal("fetch", fetcher);
});

afterEach(() => vi.unstubAllGlobals());

describe("addAvailableItem", () => {
  it.each([
    ["stock 4", 3, 2, 4],
    ["line cap 99", 98, 2, 100],
  ])("rejects %s atomically, preserving price and count", async (_label, existing, quantity, stock) => {
    const before = addToCart(emptyCart, item, existing);
    seed(before);
    fetcher.mockResolvedValue(available(stock));
    const result = await addAvailableItem(newPrice, quantity);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("最多還能加入");
    expect(saved()).toEqual(before);
    expect(result.cart).toEqual(before);
    expect(cartCount(saved())).toBe(1);
    expect(saved().lines[0]?.quantity).toBe(existing);
    expect(changed).not.toHaveBeenCalled();
  });

  it("adds within stock and updates the existing line price", async () => {
    seed(addToCart(emptyCart, item, 3));
    fetcher.mockResolvedValue(available(5));
    const result = await addAvailableItem(newPrice, 2);
    expect(result.ok).toBe(true);
    expect(saved().lines).toEqual([{ ...newPrice, quantity: 5 }]);
    expect(changed).toHaveBeenCalledOnce();
  });

  it("rejects invalid quantity without fetching or changing the cart", async () => {
    const before = addToCart(emptyCart, item, 1);
    seed(before);
    const result = await addAvailableItem(item, 0);
    expect(result.ok).toBe(false);
    expect(saved()).toEqual(before);
    expect(fetcher).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
  });

  it("does not mutate or claim success when stock cannot be confirmed", async () => {
    seed(addToCart(emptyCart, item, 1));
    fetcher.mockRejectedValue(new Error("offline"));
    const result = await addAvailableItem(item, 1);
    expect(result).toMatchObject({ ok: false, message: STOCK_ERROR });
    expect(saved().lines[0]?.quantity).toBe(1);
    expect(changed).not.toHaveBeenCalled();
  });

  it("uses the latest cart after an outstanding availability request", async () => {
    let release!: (value: Response) => void;
    fetcher.mockReturnValue(new Promise<Response>(resolve => { release = resolve; }));
    const pending = addAvailableItem(newPrice, 2);
    seed(addToCart(emptyCart, item, 3));
    release(available(4));
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(saved().lines).toEqual([{ ...item, quantity: 3 }]);
  });

  it("reports storage failure without claiming success", async () => {
    storage = { getItem: () => null, setItem: () => { throw new Error("full"); } };
    const result = await addAvailableItem(item, 1);
    expect(result).toMatchObject({ ok: false, message: SAVE_FAILED_MESSAGE, cart: emptyCart });
  });
});

describe("changeAvailableQuantity and removeAvailableItem", () => {
  it("rejects an increase above stock and preserves the line", async () => {
    const before = addToCart(emptyCart, item, 3);
    seed(before);
    fetcher.mockResolvedValue(available(4));
    const result = await changeAvailableQuantity(1, 5);
    expect(result.ok).toBe(false);
    expect(saved()).toEqual(before);
  });

  it("allows reduction and removal while offline", async () => {
    seed(addToCart(emptyCart, item, 3));
    fetcher.mockRejectedValue(new Error("offline"));
    expect((await changeAvailableQuantity(1, 2)).ok).toBe(true);
    expect(saved().lines[0]?.quantity).toBe(2);
    expect((await removeAvailableItem(1)).ok).toBe(true);
    expect(saved()).toEqual(emptyCart);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects invalid values without a lookup or mutation", async () => {
    const before = addToCart(emptyCart, item, 3);
    seed(before);
    for (const quantity of [0, 1.5, 100, Number.NaN]) {
      expect((await changeAvailableQuantity(1, quantity)).ok).toBe(false);
    }
    expect(saved()).toEqual(before);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects an increase if the line changed during the lookup", async () => {
    seed(addToCart(emptyCart, item, 2));
    let release!: (value: Response) => void;
    fetcher.mockReturnValue(new Promise<Response>(resolve => { release = resolve; }));
    const pending = changeAvailableQuantity(1, 4);
    seed(addToCart(emptyCart, item, 3));
    release(available(10));
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(saved().lines[0]?.quantity).toBe(3);
  });
});

it("serializes competing adds through the cross-tab lock and rejects the later over-limit addition", async () => {
  let queue = Promise.resolve();
  const request = vi.fn((_name: string, apply: () => unknown) => {
    const next = queue.then(apply);
    queue = next.then(() => {});
    return next;
  });
  vi.stubGlobal("navigator", { locks: { request } });
  seed(addToCart(emptyCart, item, 3));
  fetcher.mockResolvedValue(available(4));
  const results = await Promise.all([addAvailableItem(item, 1), addAvailableItem(item, 1)]);
  expect(results.map(result => result.ok)).toEqual([true, false]);
  expect(saved().lines[0]?.quantity).toBe(4);
  expect(request).toHaveBeenCalledTimes(2);
});

it("reports missing variants and failed increase checks without changing quantities", async () => {
  seed(addToCart(emptyCart, item, 2));
  fetcher.mockImplementation(async () => new Response(JSON.stringify({ variants: [] })));
  expect((await addAvailableItem(item, 1)).message).toContain("目前無法購買");
  expect((await changeAvailableQuantity(1, 3)).message).toContain("目前無法購買");
  fetcher.mockRejectedValue(new Error("offline"));
  expect((await changeAvailableQuantity(1, 3)).message).toBe(STOCK_ERROR);
  expect(saved().lines[0]?.quantity).toBe(2);
});

it("accepts a valid increase, rejects an invalid item, and handles a removed line", async () => {
  seed(addToCart(emptyCart, item, 2));
  expect((await changeAvailableQuantity(1, 3)).ok).toBe(true);
  expect((await addAvailableItem({ ...item, unitPriceTwd: 0 }, 1)).ok).toBe(false);
  expect(saved().lines[0]?.quantity).toBe(3);
  expect((await changeAvailableQuantity(99, 2)).ok).toBe(false);
});
