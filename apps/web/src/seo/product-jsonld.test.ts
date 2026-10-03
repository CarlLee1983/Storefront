import { describe, expect, it } from "vitest";
import { productJsonLd, serializeJsonLd, VARIES_BY_PROPERTIES, type JsonLdProduct } from "./product-jsonld";

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

const condition = "https://schema.org/NewCondition";

describe("productJsonLd", () => {
  it("無選項商品是 Product＋單一 Offer，幣別 TWD、有貨為 InStock、全新，圖片用最大尺寸的絕對網址", () => {
    expect(productJsonLd(plain, pageUrl, origin)).toEqual({
      "@context": "https://schema.org", "@type": "Product", name: "馬克杯", url: pageUrl, description: "手作", image: [`${origin}/images/a-1280`], sku: "7",
      offers: { "@type": "Offer", url: pageUrl, price: 320, priceCurrency: "TWD", itemCondition: condition, availability: "https://schema.org/InStock" },
    });
  });

  it("售完的變體是 OutOfStock", () => {
    const soldOut = { ...plain, variants: [{ ...plain.variants[0]!, available: 0 }] };
    expect(productJsonLd(soldOut, pageUrl, origin)).toMatchObject({ offers: { availability: "https://schema.org/OutOfStock" } });
  });

  it("有選項的商品是 ProductGroup：variesBy 用 schema.org 屬性，每個變體各自的價格、供貨與可直接開啟的網址，沒有 AggregateOffer", () => {
    const data = productJsonLd(table, pageUrl, origin) as { hasVariant: Record<string, unknown>[] } & Record<string, unknown>;
    expect(data).toMatchObject({ "@type": "ProductGroup", url: pageUrl, productGroupID: "8", variesBy: ["https://schema.org/size"] });
    expect(data).not.toHaveProperty("offers");
    expect(data).not.toHaveProperty("description");
    expect(data.hasVariant).toEqual([
      { "@type": "Product", sku: "variant-80", name: "餐桌 / 120", size: "120", offers: { "@type": "Offer", url: `${pageUrl}?variant=80`, price: 9000, priceCurrency: "TWD", itemCondition: condition, availability: "https://schema.org/InStock" } },
      { "@type": "Product", sku: "variant-81", name: "餐桌 / 150", size: "150", image: `${origin}/images/a-1280`, offers: { "@type": "Offer", url: `${pageUrl}?variant=81`, price: 12000, priceCurrency: "TWD", itemCondition: condition, availability: "https://schema.org/OutOfStock" } },
    ]);
  });

  it("兩個選項維度各自對應屬性；對應不到的維度不放進 variesBy 也不帶屬性值", () => {
    const sofa: JsonLdProduct = { ...table, optionNames: ["顏色", "款式"], variants: [{ id: 90, optionValues: ["灰", "三人座"], priceTwd: 100, available: 1, imageId: null }] };
    const data = productJsonLd(sofa, pageUrl, origin) as { hasVariant: Record<string, unknown>[] } & Record<string, unknown>;
    expect(data.variesBy).toEqual(["https://schema.org/color"]);
    expect(data.hasVariant[0]).toMatchObject({ color: "灰" });
    expect(data.hasVariant[0]).not.toHaveProperty("款式");
  });

  it("全部都對應不到時沒有 variesBy", () => {
    const data = productJsonLd({ ...table, optionNames: ["款式"] }, pageUrl, origin);
    expect(data).not.toHaveProperty("variesBy");
  });

  it("選項名稱對應表", () => {
    expect(VARIES_BY_PROPERTIES).toEqual({ 顏色: "color", 尺寸: "size", 材質: "material", 花色: "pattern", 圖案: "pattern" });
  });

  it("全部停賣沒有變體：整段不輸出", () => {
    expect(productJsonLd({ ...table, variants: [] }, pageUrl, origin)).toBeNull();
    expect(productJsonLd({ ...plain, variants: [] }, pageUrl, origin)).toBeNull();
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
