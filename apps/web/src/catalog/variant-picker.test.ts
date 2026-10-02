import type { VariantDetail } from "@storefront/app/catalog-types";
import { describe, expect, it } from "vitest";
import { describeAvailability, findVariant, initialVariant, optionChoices, selectOption, variantLabel } from "./variant-picker";

const variant = (id: number, optionValues: string[], available: number, overrides: Partial<VariantDetail> = {}): VariantDetail => ({
  id, isDefault: id === 1, optionValues, priceTwd: 1000 * id, compareAtPriceTwd: null, available, imageId: null, ...overrides,
});

// 尺寸 × 顏色：只販售三種組合（150 公分只有胡桃色）
const table = [
  variant(1, ["120 公分", "胡桃色"], 0),
  variant(2, ["120 公分", "白橡色"], 4),
  variant(3, ["150 公分", "胡桃色"], 2),
];

describe("initialVariant", () => {
  it("選第一個可購買的變體；全部售完就選第一個；沒有變體為 null", () => {
    expect(initialVariant(table)?.id).toBe(2);
    expect(initialVariant([variant(1, ["a"], 0), variant(2, ["b"], 0)])?.id).toBe(1);
    expect(initialVariant([])).toBeNull();
  });
});

describe("findVariant", () => {
  it("依選項值找到確切的變體；沒有販售的組合找不到", () => {
    expect(findVariant(table, ["120 公分", "白橡色"])?.id).toBe(2);
    expect(findVariant(table, ["150 公分", "白橡色"])).toBeUndefined();
  });

  it("沒有選項的商品，空選取對應預設變體", () => {
    expect(findVariant([variant(1, [], 3)], [])?.id).toBe(1);
  });
});

describe("selectOption", () => {
  it("改選後的組合有販售就只改該維度", () => {
    expect(selectOption(table, ["120 公分", "白橡色"], 1, "胡桃色")).toEqual(["120 公分", "胡桃色"]);
  });

  it("改選後的組合沒有販售：改選含此值的可購買變體的其他維度，結果一定對應到變體", () => {
    const next = selectOption(table, ["120 公分", "白橡色"], 0, "150 公分");
    expect(next).toEqual(["150 公分", "胡桃色"]);
    expect(findVariant(table, next)).toBeDefined();
  });

  it("含此值的變體都售完時仍會選到其中第一個，讓畫面顯示已售完", () => {
    expect(selectOption(table, ["120 公分", "白橡色"], 1, "胡桃色")).toEqual(["120 公分", "胡桃色"]);
    expect(findVariant(table, ["120 公分", "胡桃色"])?.available).toBe(0);
  });
});

describe("optionChoices", () => {
  it("各維度的值依出現順序去重，標示選取與售完", () => {
    expect(optionChoices(table, ["120 公分", "白橡色"], 0)).toEqual([
      { value: "120 公分", selected: true, soldOut: false },
      { value: "150 公分", selected: false, soldOut: false },
    ]);
    expect(optionChoices(table, ["120 公分", "白橡色"], 1)).toEqual([
      { value: "胡桃色", selected: false, soldOut: false },
      { value: "白橡色", selected: true, soldOut: false },
    ]);
  });

  it("含此值的變體全部售完才標售完", () => {
    const soldOutWalnut = [variant(1, ["胡桃色"], 0), variant(2, ["白橡色"], 3)];
    expect(optionChoices(soldOutWalnut, ["白橡色"], 0).map(({ value, soldOut }) => [value, soldOut])).toEqual([["胡桃色", true], ["白橡色", false]]);
  });
});

describe("describeAvailability", () => {
  it.each([[0, "已售完"], [-1, "已售完"], [1, "僅剩 1 件現貨"], [5, "僅剩 5 件現貨"], [6, "現貨，可售 6 件"]])("%i → %s", (available, text) => {
    expect(describeAvailability(available)).toBe(text);
  });
});

describe("variantLabel", () => {
  it("標籤以「 / 」相連，沒有選項為空字串", () => {
    expect(variantLabel(table[0]!)).toBe("120 公分 / 胡桃色");
    expect(variantLabel(variant(9, [], 1))).toBe("");
  });
});
