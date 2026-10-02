import type { ProductImage } from "../product-images";
import type { DeliveryType } from "../shipping/types";

/** 前台商品項目：只含上架中的商品，帶封面與是否可購買；商品清單、分類頁與詳情頁的同分類推薦共用。價格只看販售中（未停賣）的變體。 */
export interface ProductSummary {
  id: number;
  name: string;
  description: string;
  /** 預設變體的編號：沒有選項的商品從列表直接加入購物車用（ADR 0005）；有選項的商品要進詳情頁選變體。 */
  defaultVariantId: number;
  /** 是否有選項維度（顏色、尺寸等）；沒有選項的商品只有預設變體。 */
  hasOptions: boolean;
  /** 販售中變體的最低單價，新台幣整數元；所有變體都停賣時為 null（不得顯示可購買的報價）。 */
  priceTwd: number | null;
  /** 販售中變體的最高單價；與 `priceTwd` 同時為 null。最低與最高相同時列表只顯示一個價格。 */
  maxPriceTwd: number | null;
  /** 原價，新台幣整數元；只在沒有選項、預設變體販售中且特價時有值，其餘為 null。 */
  compareAtPriceTwd: number | null;
  /** 是否有特價選項：至少一個販售中的變體有原價。有選項的商品列表據此標示「有特價選項」。 */
  onSale: boolean;
  /** 是否還能購買：至少一個販售中的變體可售數量 > 0。 */
  purchasable: boolean;
  /** 依圖片順位挑第一張；下架與舊資料可能沒有圖片。 */
  cover: ProductImage | null;
}

/** 詳情頁可選購的變體：只含販售中的；停賣的變體不對顧客出現。 */
export interface VariantDetail {
  id: number;
  isDefault: boolean;
  /** 依商品選項維度的順序；沒有選項的商品為空陣列。 */
  optionValues: string[];
  /** 這個變體的確切單價與原價（原價 null 表示沒有特價）。 */
  priceTwd: number;
  compareAtPriceTwd: number | null;
  /** 可售數量（在庫數減保留），最小為 0。 */
  available: number;
  /** 選取此變體時顯示的商品圖片（`images` 中的一張）；null 表示不指定，維持目前顯示。 */
  imageId: string | null;
  /** 配送類型：結帳時依它計運費。 */
  deliveryType: DeliveryType;
}

/** 後台的變體列：包含停賣的，帶在庫數、保留數與可售數量。 */
export interface AdminVariant {
  id: number;
  isDefault: boolean;
  /** 依商品選項維度的順序；沒有選項的商品為空陣列。 */
  optionValues: string[];
  priceTwd: number;
  compareAtPriceTwd: number | null;
  onHand: number;
  reserved: number;
  available: number;
  discontinued: boolean;
  /** 選取此變體時顯示的商品圖片編號；null 表示不指定。 */
  imageId: string | null;  /** 配送類型；改它只影響之後的訂單。 */
  deliveryType: DeliveryType;
}
