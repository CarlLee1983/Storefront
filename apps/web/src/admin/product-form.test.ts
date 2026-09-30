import { describe, expect, it } from "vitest";
import {
  describeFailure,
  dispatchProductForm,
  formToRecord,
  parseProductId,
  productFormToInput,
  productUpdateFormToInput,
  stockAdjustFormToInput,
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

  it("庫存調整的表單解析出商品編號與增減量", () => {
    expect(dispatchProductForm(form({ intent: "adjust-stock", id: "3", delta: "-3" }))).toEqual({
      kind: "stock",
      input: { id: 3, delta: -3 },
    });
  });

  it("庫存調整缺少或無效的 id 是 invalid，不呼叫 RPC", () => {
    expect(dispatchProductForm(form({ intent: "adjust-stock", delta: "5" }))).toEqual({ kind: "invalid" });
    expect(dispatchProductForm(form({ intent: "adjust-stock", id: "0", delta: "5" }))).toEqual({ kind: "invalid" });
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

describe("stockAdjustFormToInput", () => {
  it("商品編號與增減量轉成 RPC 輸入，+20 與 -3 都是數字", () => {
    expect(stockAdjustFormToInput(form({ delta: "+20" }), 3)).toEqual({ id: 3, delta: 20 });
    expect(stockAdjustFormToInput(form({ delta: "-3" }), 3)).toEqual({ id: 3, delta: -3 });
  });

  it("增減量留空或不是數字為 NaN，不在 Web 判斷，由 App 回報欄位錯誤", () => {
    expect(stockAdjustFormToInput(form({}), 3).delta).toBeNaN();
    expect(stockAdjustFormToInput(form({ delta: "abc" }), 3).delta).toBeNaN();
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

  it("insufficient_stock 說庫存不足", () => {
    expect(describeFailure({ reason: "insufficient_stock" }, "操作失敗")).toEqual({
      message: "庫存不足：調整後的可售數量不可為負",
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
