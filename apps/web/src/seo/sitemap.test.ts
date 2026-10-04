import { describe, expect, it } from "vitest";
import { chunkPaths, robotsTxt, sitemapIndexXml, sitemapPaths, urlsetXml } from "./sitemap";

describe("sitemapPaths", () => {
  const paths = sitemapPaths(["living", "a&b"], [3, 5]);

  it("收錄固定公開頁、分類頁與商品頁", () => {
    expect(paths).toEqual(expect.arrayContaining(["/", "/products", "/about", "/faq", "/returns", "/categories/living", "/categories/a%26b", "/products/3", "/products/5"]));
  });

  it("不暴露帳戶、訂單、購物車、結帳、登入、搜尋與後台", () => {
    expect(paths.filter((path) => /^\/(account|orders|cart|checkout|login|search|admin|api)/.test(path))).toEqual([]);
  });
});

describe("chunkPaths", () => {
  it("超過上限就分檔，剛好等於上限不分", () => {
    expect(chunkPaths(["/a", "/b", "/c"], 2)).toEqual([["/a", "/b"], ["/c"]]);
    expect(chunkPaths(["/a", "/b"], 2)).toEqual([["/a", "/b"]]);
  });

  it("預設上限是 50,000，沒有路徑也回一個空檔", () => {
    expect(chunkPaths(Array.from({ length: 50_001 }, (_, i) => `/p/${i}`)).map((chunk) => chunk.length)).toEqual([50_000, 1]);
    expect(chunkPaths([])).toEqual([[]]);
  });
});

describe("XML", () => {
  it("urlset 用正式 origin 並跳脫特殊字元", () => {
    const xml = urlsetXml("https://shop.example", ["/products/1", "/x?a=1&b=2"]);
    expect(xml).toContain("<loc>https://shop.example/products/1</loc>");
    expect(xml).toContain("<loc>https://shop.example/x?a=1&#38;b=2</loc>");
    expect(xml).not.toContain("lastmod");
  });

  it("sitemap index 指向各分檔", () => {
    expect(sitemapIndexXml("https://shop.example", 2)).toContain("<loc>https://shop.example/sitemap-2.xml</loc>");
  });
});

describe("robotsTxt", () => {
  it("引用 sitemap，並擋掉非公開路徑", () => {
    const text = robotsTxt("https://shop.example");
    expect(text).toContain("Sitemap: https://shop.example/sitemap.xml");
    for (const path of ["/admin", "/account", "/orders", "/cart", "/checkout"]) expect(text).toContain(`Disallow: ${path}`);
  });
});
