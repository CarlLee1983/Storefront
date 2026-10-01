import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { loadCatalog, parseCatalog } from "./catalog";

const product = {
  key: "a", name: "A", description: "說明", category: "living", priceTwd: 100, onHand: 1, featured: false,
  images: [{ file: "images/a.jpg", prompt: "p" }],
};
const category = { slug: "living", name: "客廳", blurb: "沙發", image: { file: "images/c.jpg", prompt: "p" } };

describe("parseCatalog", () => {
  test("把相對路徑轉成以清單目錄為準的絕對路徑", () => {
    const catalog = parseCatalog({ categories: [category], products: [product] }, "/repo/demo");
    expect(catalog.categories[0]!.imageFile).toBe("/repo/demo/images/c.jpg");
    expect(catalog.products[0]!.imageFiles).toEqual(["/repo/demo/images/a.jpg"]);
    expect(catalog.products[0]!.compareAtPriceTwd).toBeNull();
  });

  test("商品指向不存在的分類時拒絕", () => {
    expect(() => parseCatalog({ categories: [category], products: [{ ...product, category: "dining" }] }, "/d")).toThrow(/dining/);
  });

  test("重複的商品名稱或分類代稱會讓重跑判斷失準，拒絕", () => {
    expect(() => parseCatalog({ categories: [category], products: [product, { ...product, key: "b" }] }, "/d")).toThrow(/重複/);
    expect(() => parseCatalog({ categories: [category, category], products: [] }, "/d")).toThrow(/重複/);
  });

  test("原價不高於售價時拒絕", () => {
    expect(() => parseCatalog({ categories: [category], products: [{ ...product, compareAtPriceTwd: 100 }] }, "/d")).toThrow(/原價/);
  });

  test("沒有圖片或超過 8 張時拒絕（商品圖片上限）", () => {
    expect(() => parseCatalog({ categories: [category], products: [{ ...product, images: [] }] }, "/d")).toThrow(/圖片/);
    const nine = Array.from({ length: 9 }, () => product.images[0]!);
    expect(() => parseCatalog({ categories: [category], products: [{ ...product, images: nine }] }, "/d")).toThrow(/圖片/);
  });
});

test("repo 內的示範清單可以載入，而且每張圖片都存在", () => {
  const catalog = loadCatalog();
  expect(catalog.categories.length).toBeGreaterThan(0);
  expect(catalog.products.length).toBeGreaterThan(0);
  const files = [...catalog.categories.map((c) => c.imageFile), ...catalog.products.flatMap((p) => p.imageFiles)];
  expect(files.filter((file) => !existsSync(file))).toEqual([]);
});
