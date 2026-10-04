import type { ProductSummary } from "@storefront/app/catalog-types";
import { saleDisplay, type SaleDisplay } from "../sale/price";

const priceFormat = new Intl.NumberFormat("zh-TW");
const twd = (amount: number) => `NT$ ${priceFormat.format(amount)}`;

export interface CardPrice {
  /** 現價文字：單一價格，或有選項且各變體價格不同時的「最低 – 最高」；沒有報價（全部停賣）為 null。 */
  text: string | null;
  /** 沒有選項的特價商品：劃線價與折扣標籤。有選項的商品不顯示（原價屬於個別變體）。 */
  sale: SaleDisplay | null;
  /** 有選項的商品，至少一個販售中的變體特價：標示「有特價選項」。 */
  hasSaleOption: boolean;
}

/** 商品卡片的價格顯示：全部變體停賣時不給報價（不得顯示可購買的價格）。 */
export function cardPrice(product: Pick<ProductSummary, "hasOptions" | "priceTwd" | "maxPriceTwd" | "compareAtPriceTwd" | "onSale">): CardPrice {
  const { priceTwd: min, maxPriceTwd: max } = product;
  if (min === null || max === null) return { text: null, sale: null, hasSaleOption: false };
  return {
    text: min === max ? twd(min) : `${twd(min)} – ${twd(max)}`,
    sale: product.hasOptions ? null : saleDisplay(min, product.compareAtPriceTwd),
    hasSaleOption: product.hasOptions && product.onSale,
  };
}
