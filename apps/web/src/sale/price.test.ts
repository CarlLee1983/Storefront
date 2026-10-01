import { describe, expect, it } from "vitest";
import { discountPercent, saleDisplay } from "./price";

describe("discountPercent", () => {
  it.each([
    [80, 100, 20],
    [320, 450, 29],
    [1, 3, 67],
    [999, 1000, 0],
  ])("售價 %i、原價 %i 折扣 %i%%（四捨五入）", (price, compareAt, percent) => {
    expect(discountPercent(price, compareAt)).toBe(percent);
  });
});

describe("saleDisplay", () => {
  it("沒有原價不是特價", () => {
    expect(saleDisplay(320, null)).toBeNull();
  });

  it.each([320, 300])("原價 %i 不高於售價 320 時不當作特價顯示（App 不會寫入，防禦用）", (compareAt) => {
    expect(saleDisplay(320, compareAt)).toBeNull();
  });

  it("特價：帶原價與折扣標籤文字", () => {
    expect(saleDisplay(320, 450)).toEqual({ compareAtTwd: 450, percent: 29, badge: "−29%" });
  });

  it("折扣四捨五入後不足 1% 時不顯示標籤，仍顯示劃線價", () => {
    expect(saleDisplay(999, 1000)).toEqual({ compareAtTwd: 1000, percent: 0, badge: null });
  });
});
