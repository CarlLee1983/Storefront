import { MAX_ORDER_LINES } from "@storefront/app/order-limits";
import { MAX_QUANTITY, type Cart, type CartLine } from "./cart";

export { MAX_ORDER_LINES };
export const STOCK_ERROR = "暫時無法確認庫存，請重新確認庫存後再試。";
export type Availability = ReadonlyMap<number, number>;

/** 逐批查詢，避免大型舊購物車造成無界限的並行請求。null 與售完分開。 */
export async function fetchAvailability(ids: readonly number[], fetcher: typeof fetch = fetch): Promise<Availability | null> {
  const unique = [...new Set(ids)];
  const result = new Map<number, number>();
  try {
    for (let i = 0; i < unique.length; i += MAX_ORDER_LINES) {
      const batch = unique.slice(i, i + MAX_ORDER_LINES);
      const response = await fetcher(`/api/availability?variants=${batch.join(",")}`, { cache: "no-store", signal: AbortSignal.timeout(10000) });
      if (!response.ok) return null;
      const data = await response.json() as { variants?: unknown };
      if (!data || !Array.isArray(data.variants)) return null;
      for (const row of data.variants) {
        if (!row || !Number.isSafeInteger(row.variantId) || !batch.includes(row.variantId) || result.has(row.variantId) || !Number.isSafeInteger(row.available) || row.available < 0) return null;
        result.set(row.variantId, row.available);
      }
    }
    return result;
  } catch { return null; }
}

export const purchaseLimit = (available: number) => Math.min(MAX_QUANTITY, available);
export const remainingToAdd = (cart: Cart, id: number, available: number) => Math.max(0, purchaseLimit(available) - (cart.lines.find(line => line.variantId === id)?.quantity ?? 0));

export function stockIssue(line: CartLine, stock: Availability | null): string {
  if (!stock) return STOCK_ERROR;
  const available = stock.get(line.variantId);
  if (available === undefined) return "目前無法購買，請移除這件商品。";
  return line.quantity > purchaseLimit(available) ? `目前僅可購買 ${purchaseLimit(available)} 件，請調整數量。` : "";
}

export function cartStockIssue(cart: Cart, stock: Availability | null): string {
  if (cart.lines.length > MAX_ORDER_LINES) return `每張訂單最多 ${MAX_ORDER_LINES} 種商品變體，請移除部分商品。`;
  if (!stock) return STOCK_ERROR;
  return cart.lines.some(line => stockIssue(line, stock)) ? "請先調整無法購買或超過可售數量的商品。" : "";
}

/** 每次刷新使舊回應失效；查詢中不能用上一份快照放行結帳。 */
export function createStockCheck(changed: () => void, fetcher: typeof fetchAvailability = fetchAvailability) {
  let sequence = 0;
  let stock: Availability | null = null;
  let loading = false;
  let checkedIds = "";
  const key = (cart: Cart) => cart.lines.map(line => line.variantId).sort((a, b) => a - b).join(",");
  return {
    get stock() { return stock; },
    get loading() { return loading; },
    validFor(cart: Cart) { return !loading && checkedIds === key(cart) && !cartStockIssue(cart, stock); },
    async refresh(cart: Cart) {
      const request = ++sequence;
      stock = null;
      loading = true;
      changed();
      const fetched = await fetcher(cart.lines.map(line => line.variantId));
      if (request !== sequence) return;
      stock = fetched;
      checkedIds = key(cart);
      loading = false;
      changed();
    },
  };
}
