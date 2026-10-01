/** 折扣百分比：`round((1 − 售價／原價) × 100)`。呼叫端要先確認原價高於售價。 */
export function discountPercent(priceTwd: number, compareAtPriceTwd: number): number {
  return Math.round((1 - priceTwd / compareAtPriceTwd) * 100);
}

export interface SaleDisplay {
  compareAtTwd: number;
  percent: number;
  /** 折扣標籤文字（例如 `−29%`）；折扣不足 1% 時沒有標籤。 */
  badge: string | null;
}

/**
 * 商品卡與詳情頁的特價顯示資料；不是特價（沒有原價）回傳 null。
 * App 保證原價高於售價，這裡仍擋掉不合理的值，避免畫面出現 0% 以下的折扣。
 * 折扣四捨五入後不到 1%（例如 999 對 1000）時不顯示標籤：「−0%」不是有意義的資訊，只留劃線價（CONTEXT.md「特價商品」）。
 */
export function saleDisplay(priceTwd: number, compareAtPriceTwd: number | null): SaleDisplay | null {
  if (compareAtPriceTwd === null || compareAtPriceTwd <= priceTwd) return null;
  const percent = discountPercent(priceTwd, compareAtPriceTwd);
  return { compareAtTwd: compareAtPriceTwd, percent, badge: percent >= 1 ? `−${percent}%` : null };
}
