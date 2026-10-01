import { describe, expect, it } from "vitest";
import { listingHref, MAX_PAGE, parseListingParams, reachedDisplayLimit } from "./params";

const parse = (query: string) => parseListingParams(new URLSearchParams(query));

describe("parseListingParams", () => {
  it("沒有參數時是預設值：新上架、不篩選、第 1 頁", () => {
    expect(parse("")).toEqual({ sort: "new", inStock: false, onSale: false, page: 1 });
  });

  it("解析合法的排序、只看有貨與頁數", () => {
    expect(parse("sort=price-asc&instock=1&page=3")).toEqual({ sort: "price-asc", inStock: true, onSale: false, page: 3 });
    expect(parse("sort=price-desc")).toMatchObject({ sort: "price-desc" });
    expect(parse("page=20")).toMatchObject({ page: 20 });
  });

  it.each(["random", "", "NEW", "price"])("非法的排序 %j 回預設", (sort) => {
    expect(parse(`sort=${sort}`).sort).toBe("new");
  });

  it.each(["0", "1", "true", "yes", ""])("只有 instock=1 才算開啟，%j 不算", (value) => {
    expect(parse(`instock=${value}`).inStock).toBe(value === "1");
  });

  it.each(["0", "1", "true", "yes", ""])("只有 sale=1 才算只看特價，%j 不算", (value) => {
    expect(parse(`sale=${value}`).onSale).toBe(value === "1");
  });

  it("解析只看特價並與其他條件並存", () => {
    expect(parse("sale=1&instock=1&sort=price-desc")).toEqual({ sort: "price-desc", inStock: true, onSale: true, page: 1 });
  });

  it.each(["0", "-1", "21", "1.5", "abc", "", "2x", "1e1"])("非法的頁數 %j 回第 1 頁", (page) => {
    expect(parse(`page=${page}`).page).toBe(1);
  });

  it("解析搜尋關鍵字 q：去掉前後空白，空字串與只有空白視為沒有", () => {
    expect(parse("q=luma").q).toBe("luma");
    expect(parse("q=%20%20luma%20%E6%A4%85%20").q).toBe("luma 椅");
    expect(parse("q=%E5%BC%A7%E5%BD%A2").q).toBe("弧形");
    expect(parse("q=100%25&sort=price-asc")).toMatchObject({ q: "100%", sort: "price-asc" });
    for (const query of ["", "q=", "q=%20%20%20"]) expect(parse(query).q, query).toBeUndefined();
  });

  it("同一個參數出現多次時取第一個", () => {
    expect(parse("sort=price-asc&sort=price-desc&page=2&page=3")).toMatchObject({ sort: "price-asc", page: 2 });
  });
});

describe("listingHref", () => {
  const params = (query: string) => new URLSearchParams(query);

  it("沒有任何狀態時就是路徑本身", () => {
    expect(listingHref("/products", params(""), {})).toBe("/products");
  });

  it("切換排序：寫入新排序並重置頁數，預設排序不出現在網址", () => {
    expect(listingHref("/products", params("page=3"), { sort: "price-asc" })).toBe("/products?sort=price-asc");
    expect(listingHref("/products", params("sort=price-asc&page=3"), { sort: "new" })).toBe("/products");
  });

  it("切換只看有貨：寫入或移除 instock 並重置頁數", () => {
    expect(listingHref("/products", params("page=2"), { inStock: true })).toBe("/products?instock=1");
    expect(listingHref("/products", params("instock=1&page=2"), { inStock: false })).toBe("/products");
  });

  it("切換只看特價：寫入或移除 sale 並重置頁數", () => {
    expect(listingHref("/products", params("page=2"), { onSale: true })).toBe("/products?sale=1");
    expect(listingHref("/products", params("sale=1&page=2"), { onSale: false })).toBe("/products");
  });

  it("切換排序、只看有貨與載入更多時保留目前的只看特價", () => {
    expect(listingHref("/products", params("sale=1"), { sort: "price-desc" })).toBe("/products?sort=price-desc&sale=1");
    expect(listingHref("/products", params("sale=1"), { inStock: true })).toBe("/products?instock=1&sale=1");
    expect(listingHref("/products", params("sale=1&instock=1"), { page: 2 })).toBe("/products?instock=1&sale=1&page=2");
  });

  it("切換排序時保留目前的只看有貨，切換只看有貨時保留目前的排序", () => {
    expect(listingHref("/products", params("instock=1"), { sort: "price-desc" })).toBe("/products?sort=price-desc&instock=1");
    expect(listingHref("/products", params("sort=price-desc"), { inStock: true })).toBe("/products?sort=price-desc&instock=1");
  });

  it("載入更多：只改頁數，保留排序與篩選", () => {
    expect(listingHref("/products", params("sort=price-asc&instock=1"), { page: 2 })).toBe("/products?sort=price-asc&instock=1&page=2");
  });

  it("頁數 1 不出現在網址", () => {
    expect(listingHref("/products", params("page=2"), { page: 1 })).toBe("/products");
  });

  it("保留不相關的其他參數", () => {
    expect(listingHref("/products", params("q=luma&utm_source=a&page=2"), { sort: "price-asc" })).toBe("/products?q=luma&utm_source=a&sort=price-asc");
    expect(listingHref("/products", params("q=luma&sort=price-asc"), { page: 2 })).toBe("/products?q=luma&sort=price-asc&page=2");
  });

  it("搜尋關鍵字在切換排序、篩選與載入更多時都保留，頁數重置規則不變", () => {
    expect(listingHref("/search", params("q=luma&page=3"), { sort: "price-asc" })).toBe("/search?q=luma&sort=price-asc");
    expect(listingHref("/search", params("q=luma&sort=price-asc&page=3"), { inStock: true })).toBe("/search?q=luma&sort=price-asc&instock=1");
    expect(listingHref("/search", params("q=luma&instock=1"), { page: 2 })).toBe("/search?q=luma&instock=1&page=2");
    expect(listingHref("/search", params("q=100%25+%E6%A3%89"), { sort: "price-desc" })).toBe("/search?q=100%25+%E6%A3%89&sort=price-desc");
  });

  it("目前網址上的非法值不會被帶到新網址", () => {
    expect(listingHref("/products", params("sort=random&instock=yes&page=99"), { page: 2 })).toBe("/products?page=2");
    expect(listingHref("/products", params("sort=random&instock=yes&page=99"), {})).toBe("/products");
  });

  it("不改動傳入的參數", () => {
    const current = params("page=2");
    listingHref("/products", current, { sort: "price-asc" });
    expect(current.toString()).toBe("page=2");
  });
});

describe("reachedDisplayLimit", () => {
  it("到達頁數上限且還有沒顯示的商品才算達到上限", () => {
    expect(reachedDisplayLimit(MAX_PAGE, 480, 500)).toBe(true);
    expect(reachedDisplayLimit(MAX_PAGE, 480, 480)).toBe(false);
    expect(reachedDisplayLimit(MAX_PAGE - 1, 456, 500)).toBe(false);
  });
});
