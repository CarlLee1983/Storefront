import { describe, expect, it, vi } from "vitest";
import { addToCart, emptyCart } from "./cart";
import { cartStockIssue, createStockCheck, fetchAvailability, MAX_ORDER_LINES, STOCK_ERROR, stockIssue } from "./availability";

const item = { variantId: 1, productId: 1, name: "馬克杯", unitPriceTwd: 320 };
const cart = addToCart(emptyCart, item, 3);
const response = (variants: unknown, ok = true) => ({ ok, json: async () => ({ variants }) }) as Response;

describe("fetchAvailability", () => {
  it("deduplicates IDs, batches at 20, sends no-store requests sequentially", async () => {
    const ids = Array.from({ length: MAX_ORDER_LINES + 2 }, (_, i) => i + 1);
    let releaseFirst!: (value: Response) => void;
    const first = new Promise<Response>(resolve => { releaseFirst = resolve; });
    const fetcher = vi.fn().mockReturnValueOnce(first).mockResolvedValueOnce(response([{ variantId: 21, available: 0 }, { variantId: 22, available: 4 }]));
    const pending = fetchAvailability([...ids, 1, 21], fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe(`/api/availability?variants=${ids.slice(0, 20).join(",")}`);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ cache: "no-store" });
    expect(fetcher.mock.calls[0]?.[1].signal).toBeInstanceOf(AbortSignal);
    releaseFirst(response(ids.slice(0, 20).map(variantId => ({ variantId, available: 5 }))));
    const result = await pending;
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]?.[0]).toBe("/api/availability?variants=21,22");
    expect(result?.size).toBe(22);
    expect(result?.get(21)).toBe(0);
  });

  it.each([
    ["HTTP failure", response([], false)],
    ["missing variants array", { ok: true, json: async () => ({}) } as Response],
    ["duplicate row", response([{ variantId: 1, available: 2 }, { variantId: 1, available: 2 }])],
    ["unexpected ID", response([{ variantId: 2, available: 2 }])],
    ["invalid stock", response([{ variantId: 1, available: -1 }])],
  ])("returns null for %s", async (_label, result) => {
    expect(await fetchAvailability([1], vi.fn().mockResolvedValue(result))).toBeNull();
  });

  it("treats an omitted variant as unavailable, distinct from a failed lookup", async () => {
    const stock = await fetchAvailability([1], vi.fn().mockResolvedValue(response([])));
    expect(stock).toEqual(new Map());
    expect(stockIssue(cart.lines[0]!, stock)).toContain("請移除");
  });

  it("returns null for a network rejection", async () => {
    expect(await fetchAvailability([1], vi.fn().mockRejectedValue(new Error("offline")))).toBeNull();
  });
});

describe("stock issues", () => {
  it("distinguishes unknown stock, missing variant, insufficient stock, and available stock", () => {
    const line = cart.lines[0]!;
    expect(stockIssue(line, null)).toBe(STOCK_ERROR);
    expect(stockIssue(line, new Map())).toContain("請移除");
    expect(stockIssue(line, new Map([[1, 2]]))).toContain("2 件");
    expect(stockIssue(line, new Map([[1, 3]]))).toBe("");
    expect(cartStockIssue(cart, null)).toBe(STOCK_ERROR);
    expect(cartStockIssue(cart, new Map([[1, 2]]))).not.toBe("");
    expect(cartStockIssue(cart, new Map([[1, 3]]))).toBe("");
  });

  it("checks line-count limit before availability", () => {
    const many = { ...emptyCart, lines: Array.from({ length: MAX_ORDER_LINES + 1 }, (_, i) => ({ ...item, variantId: i + 1, quantity: 1 })) };
    expect(cartStockIssue(many, null)).toContain(`${MAX_ORDER_LINES}`);
  });
});

describe("createStockCheck", () => {
  it("invalidates old stock while loading and ignores an outdated response", async () => {
    const callbacks: Array<(value: Map<number, number>) => void> = [];
    const fetcher = vi.fn(() => new Promise<Map<number, number>>(resolve => callbacks.push(resolve)));
    const changed = vi.fn();
    const check = createStockCheck(changed, fetcher);
    const old = check.refresh(cart);
    expect(check.loading).toBe(true);
    expect(check.stock).toBeNull();
    expect(check.validFor(cart)).toBe(false);
    const newerCart = addToCart(cart, { ...item, variantId: 2 }, 1);
    const newer = check.refresh(newerCart);
    callbacks[0]!(new Map([[1, 3]]));
    await old;
    expect(check.loading).toBe(true);
    expect(check.stock).toBeNull();
    callbacks[1]!(new Map([[1, 3], [2, 1]]));
    await newer;
    expect(check.loading).toBe(false);
    expect(check.validFor(newerCart)).toBe(true);
    expect(check.validFor(cart)).toBe(false);
    expect(changed).toHaveBeenCalledTimes(3);
  });

  it("rejects a cart whose quantity exceeds the latest stock snapshot", async () => {
    const check = createStockCheck(() => {}, async () => new Map([[1, 3]]));
    await check.refresh(cart);
    expect(check.validFor(cart)).toBe(true);
    expect(check.validFor(addToCart(cart, item, 1))).toBe(false);
    await check.refresh(cart);
    expect(check.validFor(cart)).toBe(true);
  });
});
