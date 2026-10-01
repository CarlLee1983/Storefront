import { describe, expect, it } from "vitest";
import { categoryFormToInput, categoryIdFromSelect, categoryUpdateFormToInput, parseCategoryId } from "./category-form";

const form = (values: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
};

describe("categoryFormToInput", () => {
  it("表單欄位轉成 RPC 輸入，不在 Web 改寫內容（代稱的大小寫與空白由 App 驗證）", () => {
    expect(categoryFormToInput(form({ categoryName: "客廳", categoryDescription: "沙發與燈", categorySlug: "Living Room" }))).toEqual({
      name: "客廳",
      description: "沙發與燈",
      slug: "Living Room",
    });
  });

  it("缺少的欄位是空字串，由 App 回報錯誤", () => {
    expect(categoryFormToInput(form({}))).toEqual({ name: "", description: "", slug: "" });
  });
});

describe("categoryIdFromSelect", () => {
  it("選了分類回傳數字；選「未分類」（空字串）回傳 null", () => {
    expect(categoryIdFromSelect("3")).toBe(3);
    expect(categoryIdFromSelect("")).toBeNull();
  });

  it("欄位不存在（被竄改的表單）回傳 undefined，也就是不動分類", () => {
    expect(categoryIdFromSelect(null)).toBeUndefined();
  });

  it("不是數字的值轉成 NaN，由 App 回報錯誤而不是默默清空", () => {
    expect(categoryIdFromSelect("abc")).toBeNaN();
  });
});

describe("categoryUpdateFormToInput", () => {
  it("只帶編號、名稱與說明；表單裡的代稱欄位不會被轉進輸入", () => {
    expect(categoryUpdateFormToInput(form({ categoryName: "起居室", categoryDescription: "沙發", categorySlug: "hacked" }), 3)).toEqual({
      id: 3,
      name: "起居室",
      description: "沙發",
    });
  });

  it("缺少的欄位是空字串，由 App 回報錯誤", () => {
    expect(categoryUpdateFormToInput(form({}), 3)).toEqual({ id: 3, name: "", description: "" });
  });
});

describe("parseCategoryId", () => {
  it("正整數字串轉數字，其餘回傳 null", () => {
    expect(parseCategoryId("12")).toBe(12);
    for (const value of [undefined, "", "0", "-1", "1.5", "abc", "01"]) expect(parseCategoryId(value)).toBeNull();
  });
});
