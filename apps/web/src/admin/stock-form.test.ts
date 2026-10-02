import { describe, expect, it } from "vitest";
import { movementKindLabel, olderMovementsUrl, parseMovementFilter } from "./stock-form";

describe("庫存流水篩選", () => {
  it("只保留有效的正整數參數", () => {
    expect(parseMovementFilter(new URLSearchParams("variantId=3&orderId=12&beforeId=40"))).toEqual({ variantId: 3, orderId: 12, beforeId: 40 });
    expect(parseMovementFilter(new URLSearchParams("variantId=0&orderId=-1&beforeId=abc"))).toEqual({});
    expect(parseMovementFilter(new URLSearchParams("variantId=1e3&orderId=3.5"))).toEqual({});
    expect(parseMovementFilter(new URLSearchParams(""))).toEqual({});
  });

  it("較舊一頁的網址帶著篩選與游標", () => {
    expect(olderMovementsUrl({ variantId: 3 }, 17)).toBe("/admin/stock-movements?variantId=3&beforeId=17");
    expect(olderMovementsUrl({}, 17)).toBe("/admin/stock-movements?beforeId=17");
  });

  it("來源顯示中文名稱，不認得的代碼原樣顯示", () => {
    expect(movementKindLabel("dispatch")).toBe("交運扣庫");
    expect(movementKindLabel("future")).toBe("future");
  });
});
