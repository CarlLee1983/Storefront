import type { CheckoutLine } from "./input";

/** 結帳被拒時，某一筆明細的問題；不透露確切的可售數量。 */
export type CheckoutIssue =
  | { productId: number; kind: "product_not_found" }
  | { productId: number; kind: "unlisted" }
  | { productId: number; kind: "price_changed"; currentUnitPriceTwd: number }
  | { productId: number; kind: "insufficient_stock" };

export interface ProductState {
  id: number;
  priceTwd: number;
  listed: boolean;
  available: number;
}

/**
 * 結帳的條件寫入沒成立之後，逐筆找出原因（只影響回應，不影響正確性）。
 * 每筆最多回報一個問題，依序：商品不存在、已下架、價格變動、可售數量不足——
 * 顧客要先重新確認價格，才有意義去看數量。順序與輸入的明細一致。
 */
export function diagnoseLines(lines: CheckoutLine[], states: ProductState[]): CheckoutIssue[] {
  const byId = new Map(states.map((state) => [state.id, state]));
  return lines.flatMap((line): CheckoutIssue[] => {
    const state = byId.get(line.productId);
    if (!state) return [{ productId: line.productId, kind: "product_not_found" }];
    if (!state.listed) return [{ productId: line.productId, kind: "unlisted" }];
    if (state.priceTwd !== line.seenUnitPriceTwd) {
      return [{ productId: line.productId, kind: "price_changed", currentUnitPriceTwd: state.priceTwd }];
    }
    if (state.available < line.quantity) return [{ productId: line.productId, kind: "insufficient_stock" }];
    return [];
  });
}
