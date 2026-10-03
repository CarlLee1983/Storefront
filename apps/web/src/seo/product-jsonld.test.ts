import { describe, expect, it } from "vitest";
import { productJsonLd, serializeJsonLd, type JsonLdProduct } from "./product-jsonld";

const origin = "https://shop.example";
const pageUrl = `${origin}/products/7`;
const image = { id: "img1", variants: [{ key: "a-320", width: 320, height: 320 }, { key: "a-1280", width: 1280, height: 1280 }] };

const plain: JsonLdProduct = {
  id: 7, name: "馬克杯", description: "手作", optionNames: [], images: [image],
  variants: [{ id: 70, optionValues: [], priceTwd: 320, available: 4, imageId: null }],
};
const table: JsonLdProduct = {
  id: 8, name: "餐桌", description: "", optionNames: ["尺寸"], images: [image],
  variants: [
    { id: 80, optionValues: ["120"], priceTwd: 9000, available: 3, imageId: null },
    { id: 81, optionValues: ["150"], priceTwd: 12000, available: 0, imageId: "img1" },
  ],
};

describe("productJsonLd", () => {
  it("無選項商品是 Product＋單一 Offer，幣別 TWD、有貨為 InStock，圖片用最大尺寸的絕對網址", () => {
    expect(productJsonLd(plain, pageUrl, origin)).toEqual({
      "@context": "https://schema.org", "@type": "Product", name: "馬克杯", description: "手作", image: [`${origin}/images/a-1280`], sku: "7",
      offers: { "@type": "Offer", url: pageUrl, price: 320, priceCurrency: "TWD", availability: "https://schema.org/InStock" },
    });
  });

  it("售完的變體是 OutOfStock", () => {
    const soldOut = { ...plain, variants: [{ ...plain.variants[0]!, available: 0 }] };
    expect(productJsonLd(soldOut, pageUrl, origin)).toMatchObject({ offers: { availability: "https://schema.org/OutOfStock" } });
  });

  it("有選項的商品是 ProductGroup，每個變體各自的價格與供貨，不以最低價代表全部，也沒有 AggregateOffer", () => {
    const data = productJsonLd(table, pageUrl, origin) as { hasVariant: Record<string, unknown>[] } & Record<string, unknown>;
    expect(data).toMatchObject({ "@type": "ProductGroup", productGroupID: "8", variesBy: ["尺寸"] });
    expect(data).not.toHaveProperty("offers");
    expect(data).not.toHaveProperty("description");
    expect(data.hasVariant).toEqual([
      { "@type": "Product", sku: "variant-80", name: "餐桌 / 120", offers: { "@type": "Offer", url: pageUrl, price: 9000, priceCurrency: "TWD", availability: "https://schema.org/InStock" } },
      { "@type": "Product", sku: "variant-81", name: "餐桌 / 150", image: `${origin}/images/a-1280`, offers: { "@type": "Offer", url: pageUrl, price: 12000, priceCurrency: "TWD", availability: "https://schema.org/OutOfStock" } },
    ]);
  });

  it("全部停賣沒有變體：不輸出報價，也不虛構評價或品牌", () => {
    const data = productJsonLd({ ...table, variants: [] }, pageUrl, origin);
    expect(data).toMatchObject({ "@type": "Product" });
    expect(data).not.toHaveProperty("offers");
    expect(data).not.toHaveProperty("aggregateRating");
    expect(data).not.toHaveProperty("review");
    expect(data).not.toHaveProperty("brand");
  });
});

describe("serializeJsonLd", () => {
  it("管理員輸入的 </script> 不會跳出標籤，且解析後內容不變", () => {
    const name = '</script><script>alert(1)</script> & <!-- \u2028';
    const out = serializeJsonLd({ name });
    expect(out).not.toMatch(/[<>&\u2028\u2029]/);
    expect(JSON.parse(out)).toEqual({ name });
  });
});
