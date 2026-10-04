import type { AdminVariant } from "@storefront/app/catalog-types";

export interface ProductVariantSummary {
  /** 有一個以上的變體：後台清單的價格與庫存是彙總，庫存要到編輯頁逐一變體調整。 */
  multiple: boolean;
  minPriceTwd: number;
  maxPriceTwd: number;
  onHand: number;
  unavailable: number;
  reserved: number;
  available: number;
}

/** 後台清單一列的彙總：單一變體就是它自己；多個變體時價格取範圍、庫存取各變體加總（停賣的變體仍算，庫存還在倉內）。 */
export function summarizeVariants(product: { variants: readonly AdminVariant[] }): ProductVariantSummary {
  const { variants } = product;
  return {
    multiple: variants.length > 1,
    minPriceTwd: Math.min(...variants.map((variant) => variant.priceTwd)),
    maxPriceTwd: Math.max(...variants.map((variant) => variant.priceTwd)),
    onHand: variants.reduce((sum, variant) => sum + variant.onHand, 0),
    unavailable: variants.reduce((sum, variant) => sum + variant.unavailable, 0),
    reserved: variants.reduce((sum, variant) => sum + variant.reserved, 0),
    available: variants.reduce((sum, variant) => sum + variant.available, 0),
  };
}
