import type { ProductImage } from "@storefront/app/product-images";
import type { VariantDetail } from "@storefront/app/catalog-types";

export interface JsonLdProduct {
  id: number;
  name: string;
  description: string;
  optionNames: string[];
  images: ProductImage[];
  /** 只含販售中（未停賣）的變體，與頁面顯示的一致。 */
  variants: Pick<VariantDetail, "id" | "optionValues" | "priceTwd" | "available" | "imageId">[];
}

const availabilityOf = (available: number) => (available > 0 ? "https://schema.org/InStock" : "https://schema.org/OutOfStock");

/** Google 的 `variesBy` 只接受這幾個屬性；選項名稱對應不到的維度不放進 variesBy，也不帶屬性值。 */
export const VARIES_BY_PROPERTIES: Record<string, "color" | "size" | "material" | "pattern"> = {
  顏色: "color",
  尺寸: "size",
  材質: "material",
  花色: "pattern",
  圖案: "pattern",
};

const imageUrl = (origin: string, image: ProductImage) => {
  const largest = image.variants.at(-1);
  return largest ? `${origin}/images/${largest.key}` : null;
};

/** 變體各自可直接開啟的網址：頁面依 `?variant=` 預選該變體（canonical 仍是不帶參數的商品頁）。 */
export const variantUrl = (pageUrl: string, variantId: number) => `${pageUrl}?variant=${variantId}`;

/**
 * 商品頁的 schema.org 結構化資料。只輸出頁面上看得到的資料：
 * 沒有選項的商品是 Product＋Offer；有選項的商品是 ProductGroup，每個販售中變體各有自己的價格與供貨（不以最低價代表全部）。
 * 沒有任何販售中變體（全部停賣、頁面不給報價）時回 null，不輸出。不輸出評價、品牌等資料庫沒有的欄位。
 */
export function productJsonLd(product: JsonLdProduct, pageUrl: string, origin: string): Record<string, unknown> | null {
  if (product.variants.length === 0) return null;
  const images = product.images.map((image) => imageUrl(origin, image)).filter((url): url is string => url !== null);
  const base = {
    "@context": "https://schema.org",
    name: product.name,
    url: pageUrl,
    ...(product.description.trim() ? { description: product.description.trim() } : {}),
    ...(images.length > 0 ? { image: images } : {}),
  };
  const offer = (variant: JsonLdProduct["variants"][number], url: string) => ({
    "@type": "Offer",
    url,
    price: variant.priceTwd,
    priceCurrency: "TWD",
    itemCondition: "https://schema.org/NewCondition",
    availability: availabilityOf(variant.available),
  });

  if (product.optionNames.length === 0) {
    return { ...base, "@type": "Product", sku: String(product.id), offers: offer(product.variants[0]!, pageUrl) };
  }
  // 兩個維度對應到同一個屬性時只取第一個，避免後者覆蓋前者
  const dimensions = product.optionNames.map((name) => VARIES_BY_PROPERTIES[name]).map((property, index, all) => (all.indexOf(property) === index ? property : undefined));
  const variesBy = [...new Set(dimensions.filter((property) => property !== undefined))].map((property) => `https://schema.org/${property}`);
  return {
    ...base,
    "@type": "ProductGroup",
    productGroupID: String(product.id),
    ...(variesBy.length > 0 ? { variesBy } : {}),
    hasVariant: product.variants.map((variant) => {
      const variantImage = product.images.find((image) => image.id === variant.imageId);
      // 沒指定圖片的變體退回商品第一張；商品完全沒有圖片就不帶
      const url = images.length > 0 ? (variantImage ? imageUrl(origin, variantImage) : null) ?? images[0]! : null;
      const properties = dimensions.flatMap((property, index) => (property === undefined ? [] : [[property, variant.optionValues[index]] as const]));
      return {
        "@type": "Product",
        sku: `variant-${variant.id}`,
        name: `${product.name} / ${variant.optionValues.join(" / ")}`,
        ...Object.fromEntries(properties),
        ...(url ? { image: url } : {}),
        offers: offer(variant, variantUrl(pageUrl, variant.id)),
      };
    }),
  };
}

/** 序列化成可放進 `<script type="application/ld+json">` 的字串：把 `<`、`>`、`&` 與行分隔字元轉成 \u 跳脫，管理員輸入的 `</script>` 無法跳出標籤。 */
export function serializeJsonLd(data: unknown): string {
  return JSON.stringify(data).replace(/[<>&\u2028\u2029]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
