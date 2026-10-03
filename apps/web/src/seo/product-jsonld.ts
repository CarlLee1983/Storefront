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

const imageUrl = (origin: string, image: ProductImage) => {
  const largest = image.variants.at(-1);
  return largest ? `${origin}/images/${largest.key}` : null;
};

/**
 * 商品頁的 schema.org 結構化資料。只輸出頁面上看得到的資料：
 * 沒有選項的商品是 Product＋Offer；有選項的商品是 ProductGroup，每個販售中變體各有自己的價格與供貨（不以最低價代表全部）；
 * 全部停賣時沒有報價，不輸出 offers。不輸出評價、品牌等資料庫沒有的欄位。
 */
export function productJsonLd(product: JsonLdProduct, pageUrl: string, origin: string): Record<string, unknown> {
  const images = product.images.map((image) => imageUrl(origin, image)).filter((url): url is string => url !== null);
  const base = {
    "@context": "https://schema.org",
    name: product.name,
    ...(product.description.trim() ? { description: product.description.trim() } : {}),
    ...(images.length > 0 ? { image: images } : {}),
  };
  const offer = (variant: JsonLdProduct["variants"][number]) => ({
    "@type": "Offer",
    url: pageUrl,
    price: variant.priceTwd,
    priceCurrency: "TWD",
    availability: availabilityOf(variant.available),
  });

  if (product.optionNames.length === 0 || product.variants.length === 0) {
    const [variant] = product.variants;
    return { ...base, "@type": "Product", sku: String(product.id), ...(variant ? { offers: offer(variant) } : {}) };
  }
  return {
    ...base,
    "@type": "ProductGroup",
    productGroupID: String(product.id),
    variesBy: product.optionNames,
    hasVariant: product.variants.map((variant) => {
      const variantImage = product.images.find((image) => image.id === variant.imageId);
      const url = variantImage ? imageUrl(origin, variantImage) : null;
      return {
        "@type": "Product",
        sku: `variant-${variant.id}`,
        name: `${product.name} / ${variant.optionValues.join(" / ")}`,
        ...(url ? { image: url } : {}),
        offers: offer(variant),
      };
    }),
  };
}

/** 序列化成可放進 `<script type="application/ld+json">` 的字串：把 `<`、`>`、`&` 與行分隔字元轉成 \u 跳脫，管理員輸入的 `</script>` 無法跳出標籤。 */
export function serializeJsonLd(data: unknown): string {
  return JSON.stringify(data).replace(/[<>&\u2028\u2029]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
