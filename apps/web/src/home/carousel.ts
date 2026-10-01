/** 主視覺輪播的純邏輯：切換張數的計算與自動輪播的間隔。 */

/** 自動輪播的切換間隔。 */
export const HERO_INTERVAL_MS = 6000;

/** 以 `index` 為基準移動 `delta` 張，頭尾相接。 */
export function stepIndex(index: number, delta: number, count: number): number {
  return (((index + delta) % count) + count) % count;
}

/** 由捲動位置換算目前是第幾張（從 0 起算），超出範圍時夾在頭尾。 */
export function indexFromScroll(scrollLeft: number, slideWidth: number, count: number): number {
  if (slideWidth <= 0) return 0;
  return Math.min(count - 1, Math.max(0, Math.round(scrollLeft / slideWidth)));
}
