import { describe, expect, it } from "vitest";
import { describeCreateFailure, formToRecord, productFormToInput } from "./product-form";

const form = (values: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
};

describe("productFormToInput", () => {
  it("表單欄位轉成 RPC 輸入，單價轉成數字", () => {
    expect(productFormToInput(form({ name: "馬克杯", description: "陶瓷", priceTwd: "320" }))).toEqual({
      name: "馬克杯",
      description: "陶瓷",
      priceTwd: 320,
    });
  });

  it("缺少的欄位不在 Web 判斷：文字為空字串、單價為 NaN", () => {
    const input = productFormToInput(form({}));
    expect(input.name).toBe("");
    expect(input.description).toBe("");
    expect(input.priceTwd).toBeNaN();
  });
});

describe("formToRecord", () => {
  it("轉成欄位名稱到字串的對照，供驗證失敗時回填", () => {
    expect(formToRecord(form({ name: "馬克杯", priceTwd: "0" }))).toEqual({ name: "馬克杯", priceTwd: "0" });
  });
});

describe("describeCreateFailure", () => {
  it("invalid_input 帶出 App 回報的欄位錯誤", () => {
    expect(describeCreateFailure({ reason: "invalid_input", fields: { name: ["名稱不可為空"] } })).toEqual({
      message: "輸入有誤，請修正後再送出",
      fields: { name: ["名稱不可為空"] },
    });
  });

  it("其他原因給通用訊息，欄位為空", () => {
    expect(describeCreateFailure({ reason: "boom" })).toEqual({
      message: "新增商品失敗，請稍後再試",
      fields: {},
    });
  });
});
