import { describe, expect, it } from "vitest";
import { dispatchVariantForm } from "./variant-form";

const formOf = (fields: Record<string, string>) => {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return form;
};

describe("dispatchVariantForm", () => {
  it("設定選項：留白的維度不算；有帶預設變體的選項值才傳", () => {
    expect(dispatchVariantForm(formOf({ intent: "set-options", optionName1: " 顏色 ", optionName2: "" }), 7)).toEqual({ kind: "set-options", input: { id: 7, optionNames: ["顏色"] } });
    expect(dispatchVariantForm(formOf({ intent: "set-options", optionName1: "顏色", optionName2: "尺寸", defaultValue1: "白", defaultValue2: "大" }), 7))
      .toEqual({ kind: "set-options", input: { id: 7, optionNames: ["顏色", "尺寸"], defaultVariantValues: ["白", "大"] } });
    expect(dispatchVariantForm(formOf({ intent: "set-options", optionName1: "", optionName2: "" }), 7)).toEqual({ kind: "set-options", input: { id: 7, optionNames: [] } });
  });

  it("頁面永遠送出兩格預設變體的選項值：只取有對應維度的那幾格", () => {
    expect(dispatchVariantForm(formOf({ intent: "set-options", optionName1: "顏色", optionName2: "", defaultValue1: "白", defaultValue2: "" }), 7))
      .toEqual({ kind: "set-options", input: { id: 7, optionNames: ["顏色"], defaultVariantValues: ["白"] } });
    expect(dispatchVariantForm(formOf({ intent: "set-options", optionName1: "", optionName2: "", defaultValue1: "", defaultValue2: "" }), 7))
      .toEqual({ kind: "set-options", input: { id: 7, optionNames: [] } });
  });

  it("新增變體：選項值依欄位出現的順序，原價留白不帶，價格轉數字", () => {
    expect(dispatchVariantForm(formOf({ intent: "create-variant", value1: "120 公分", value2: "胡桃色", priceTwd: "9000", compareAtPriceTwd: "" }), 7))
      .toEqual({ kind: "create-variant", input: { productId: 7, optionValues: ["120 公分", "胡桃色"], priceTwd: 9000 } });
    expect(dispatchVariantForm(formOf({ intent: "create-variant", value1: "白", priceTwd: "800", compareAtPriceTwd: "1000" }), 7))
      .toEqual({ kind: "create-variant", input: { productId: 7, optionValues: ["白"], priceTwd: 800, compareAtPriceTwd: 1000 } });
  });

  it("新增變體：價格不是數字時轉成 NaN，交給 App 回報", () => {
    const dispatched = dispatchVariantForm(formOf({ intent: "create-variant", value1: "白", priceTwd: "abc" }), 7);
    expect(dispatched).toMatchObject({ kind: "create-variant", input: { priceTwd: Number.NaN } });
  });

  it("修改變體：原價留白是清空、圖片留白是不指定，欄位不存在就不動", () => {
    expect(dispatchVariantForm(formOf({ intent: "update-variant", variantId: "3", value1: "白", priceTwd: "800", compareAtPriceTwd: "", imageId: "" }), 7))
      .toEqual({ kind: "update-variant", input: { variantId: 3, optionValues: ["白"], priceTwd: 800, compareAtPriceTwd: null, imageId: null } });
    expect(dispatchVariantForm(formOf({ intent: "update-variant", variantId: "3", value1: "白", priceTwd: "800", imageId: "img-1" }), 7))
      .toEqual({ kind: "update-variant", input: { variantId: 3, optionValues: ["白"], priceTwd: 800, compareAtPriceTwd: undefined, imageId: "img-1" } });
  });

  it("停賣、恢復販售與調整庫存都以變體編號為準", () => {
    expect(dispatchVariantForm(formOf({ intent: "discontinue-variant", variantId: "3" }), 7)).toEqual({ kind: "discontinue", input: { variantId: 3, discontinued: true } });
    expect(dispatchVariantForm(formOf({ intent: "resume-variant", variantId: "3" }), 7)).toEqual({ kind: "discontinue", input: { variantId: 3, discontinued: false } });
    expect(dispatchVariantForm(formOf({ intent: "adjust-variant-stock", variantId: "3", delta: "-2" }), 7)).toEqual({ kind: "adjust-stock", input: { variantId: 3, delta: -2 } });
  });

  it.each([
    ["不認得的 intent", { intent: "delete-variant", variantId: "3" }],
    ["沒有 intent", { variantId: "3" }],
    ["變體編號缺少", { intent: "discontinue-variant" }],
    ["變體編號無效", { intent: "update-variant", variantId: "0", priceTwd: "1" }],
  ])("%s：不呼叫任何 RPC", (_label, fields) => {
    expect(dispatchVariantForm(formOf(fields), 7)).toEqual({ kind: "invalid" });
  });
});
