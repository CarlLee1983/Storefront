import { describe, expect, it } from "vitest";
import { MAX_SLUG_LENGTH } from "@storefront/app/category-slug";
import { describeFailure } from "./failure";

describe("describeFailure", () => {
  it("invalid_input 帶出 App 回報的欄位錯誤", () => {
    expect(describeFailure({ reason: "invalid_input", fields: { name: ["名稱不可為空"] } }, "新增商品失敗")).toEqual({
      message: "輸入有誤，請修正後再送出",
      fields: { name: ["名稱不可為空"] },
    });
  });

  it("product_not_found 說找不到商品", () => {
    expect(describeFailure({ reason: "product_not_found" }, "操作失敗")).toEqual({
      message: "找不到這個商品",
      fields: {},
    });
  });

  it("insufficient_stock 說庫存不足", () => {
    expect(describeFailure({ reason: "insufficient_stock" }, "操作失敗")).toEqual({
      message: "庫存不足：調整後的可售數量不可為負",
      fields: {},
    });
  });

  it("invalid_compare_at_price 說明原價必須高於售價", () => {
    expect(describeFailure({ reason: "invalid_compare_at_price" }, "操作失敗")).toEqual({
      message: "原價必須高於這次儲存後的售價；要結束特價請清空原價",
      fields: {},
    });
  });

  it("category_not_empty 說明分類底下還有商品，要先移走", () => {
    expect(describeFailure({ reason: "category_not_empty" }, "操作失敗")).toEqual({
      message: "這個分類底下還有商品（不分上架與否），請先把商品移到其他分類再刪除",
      fields: {},
    });
  });

  it("圖片上傳失敗的訊息依對象不同：預設是商品圖片，分類用分類圖片", () => {
    expect(describeFailure({ reason: "image_upload_failed" }, "操作失敗").message).toBe("商品圖片上傳失敗，請稍後再試");
    expect(describeFailure({ reason: "image_upload_failed" }, "操作失敗", "分類圖片").message).toBe("分類圖片上傳失敗，請稍後再試");
  });

  it("其他原因使用呼叫端給的預設訊息，欄位為空", () => {
    expect(describeFailure({ reason: "boom" }, "新增商品失敗，請稍後再試")).toEqual({
      message: "新增商品失敗，請稍後再試",
      fields: {},
    });
  });
});

it("explains why a product without images cannot be listed", () => {
  expect(describeFailure({ reason: "no_images" }, "fallback").message).toBe("請先上傳商品圖片，再上架商品");
});

// 故事 62：分類代稱「格式錯誤」與「已被使用」要各自說清楚原因
it("invalid_slug 說明代稱的格式與長度上限", () => {
  expect(describeFailure({ reason: "invalid_slug" }, "fallback")).toEqual({
    message: `代稱只能使用小寫英文、數字與連字號（不可以連字號開頭或結尾），且不可超過 ${MAX_SLUG_LENGTH} 個字元`,
    fields: {},
  });
});

it("slug_taken 說明代稱已被使用，請換一個", () => {
  expect(describeFailure({ reason: "slug_taken" }, "fallback")).toEqual({
    message: "這個代稱已被使用，請換一個",
    fields: {},
  });
});
