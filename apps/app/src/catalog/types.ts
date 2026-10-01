import type { ProductImage } from "../product-images";

/** 前台商品項目：只含上架中的商品，帶封面與是否可購買；商品清單、分類頁與詳情頁的同分類推薦共用。 */
export interface ProductSummary {
  id: number;
  name: string;
  description: string;
  /** 單價，新台幣整數元。 */
  priceTwd: number;
  /** 原價，新台幣整數元；null 表示不是特價商品。 */
  compareAtPriceTwd: number | null;
  /** 是否還能購買（可售數量 > 0）。 */
  purchasable: boolean;
  /** 依圖片順位挑第一張；下架與舊資料可能沒有圖片。 */
  cover: ProductImage | null;
}
