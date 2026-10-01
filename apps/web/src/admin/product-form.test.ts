import { describe, expect, it } from "vitest";
import { describeFailure } from "./failure";
import {
  dispatchProductForm,
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

describe("productUpdateFormToInput", () => {
  it("表單欄位加上商品編號轉成 RPC 輸入", () => {
    expect(productUpdateFormToInput(form({ name: "大馬克杯", description: "500ml", priceTwd: "450" }), 7)).toEqual({
      id: 7,
      name: "大馬克杯",
      description: "500ml",
      priceTwd: 450,
    });
  });

  it("原價欄位：有值是數字、留空是 null（清空，結束特價）、欄位不存在是 undefined（不動）", () => {
    const base = { name: "馬克杯", description: "", priceTwd: "320" };
    expect(productUpdateFormToInput(form({ ...base, compareAtPriceTwd: "450" }), 7).compareAtPriceTwd).toBe(450);
    expect(productUpdateFormToInput(form({ ...base, compareAtPriceTwd: "" }), 7).compareAtPriceTwd).toBeNull();
    expect(productUpdateFormToInput(form({ ...base, compareAtPriceTwd: "  " }), 7).compareAtPriceTwd).toBeNull();
    expect(productUpdateFormToInput(form(base), 7).compareAtPriceTwd).toBeUndefined();
  });

  it("原價不是數字時轉成 NaN，由 App 回報欄位錯誤", () => {
    expect(productUpdateFormToInput(form({ name: "a", description: "", priceTwd: "1", compareAtPriceTwd: "abc" }), 7).compareAtPriceTwd).toBeNaN();
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

describe("分類相關", () => {
  it("商品修改表單帶出分類：選了分類是數字，選未分類是 null，沒有欄位就不動分類", () => {
    const base = { name: "馬克杯", description: "", priceTwd: "320" };
    expect(productUpdateFormToInput(form({ ...base, categoryId: "4" }), 7)).toMatchObject({ id: 7, categoryId: 4 });
    expect(productUpdateFormToInput(form({ ...base, categoryId: "" }), 7)).toMatchObject({ categoryId: null });
    expect(productUpdateFormToInput(form(base), 7).categoryId).toBeUndefined();
  });

  it("新增商品表單不帶分類（分類在編輯頁設定）", () => {
    expect(productFormToInput(form({ name: "馬克杯", description: "", priceTwd: "320", categoryId: "4" }))).not.toHaveProperty("categoryId");
  });

  it("建立分類的表單以 intent 分派", () => {
    expect(dispatchProductForm(form({ intent: "create-category", categoryName: "客廳", categoryDescription: "沙發", categorySlug: "living" }))).toEqual({
      kind: "create-category",
      input: { name: "客廳", description: "沙發", slug: "living" },
    });
  });

  it.each([
    ["no_category", "請先選擇商品分類"],
    ["category_not_found", "找不到這個分類"],
    ["invalid_slug", "代稱只能使用小寫英文"],
    ["slug_taken", "這個代稱已被使用"],
  ])("%s 有專屬的說明", (reason, text) => {
    expect(describeFailure({ reason }, "fallback").message).toContain(text);
  });
});
