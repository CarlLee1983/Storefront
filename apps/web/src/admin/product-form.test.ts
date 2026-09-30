import { describe, expect, it } from "vitest";
import {
  describeFailure,
  dispatchProductForm,
  formToRecord,
  parseProductId,
  productFormToInput,
  productUpdateFormToInput,
} from "./product-form";

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

describe("productUpdateFormToInput", () => {
  it("表單欄位加上商品編號轉成 RPC 輸入", () => {
    expect(productUpdateFormToInput(form({ name: "大馬克杯", description: "500ml", priceTwd: "450" }), 7)).toEqual({
      id: 7,
      name: "大馬克杯",
      description: "500ml",
      priceTwd: 450,
    });
  });
});

describe("parseProductId", () => {
  it("正整數字串轉成數字", () => {
    expect(parseProductId("12")).toBe(12);
  });

  it.each([[undefined], [""], ["abc"], ["0"], ["-3"], ["1.5"]])("無效的商品編號（%s）回傳 null", (value) => {
    expect(parseProductId(value)).toBeNull();
  });
});

describe("dispatchProductForm", () => {
  it("沒有 intent 欄位的表單是新增商品", () => {
    expect(dispatchProductForm(form({ name: "馬克杯", description: "", priceTwd: "320" }))).toEqual({ kind: "create" });
  });

  it("下架與重新上架的表單解析出動作與商品編號", () => {
    expect(dispatchProductForm(form({ intent: "unlist", id: "3" }))).toEqual({ kind: "listing", action: "unlist", id: 3 });
    expect(dispatchProductForm(form({ intent: "relist", id: "3" }))).toEqual({ kind: "listing", action: "relist", id: 3 });
  });

  it.each([
    ["未知的 intent（delete）", { intent: "delete", id: "3" }],
    ["intent 是 create 也不當成新增", { intent: "create", id: "3" }],
    ["缺少 id", { intent: "unlist" }],
    ["id 不是數字", { intent: "unlist", id: "x" }],
    ["id 為 0", { intent: "relist", id: "0" }],
  ])("有 intent 但無法解析（%s）是 invalid，不會落到新增", (_label, values) => {
    expect(dispatchProductForm(form(values))).toEqual({ kind: "invalid" });
  });
});

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

  it("其他原因使用呼叫端給的預設訊息，欄位為空", () => {
    expect(describeFailure({ reason: "boom" }, "新增商品失敗，請稍後再試")).toEqual({
      message: "新增商品失敗，請稍後再試",
      fields: {},
    });
  });
});
