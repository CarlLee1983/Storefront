import { describe, expect, it } from "vitest";
import { formToRecord, toNumber, toText } from "./form-values";

describe("toNumber", () => {
  it("數字字串轉成數字", () => {
    expect(toNumber("320")).toBe(320);
  });

  it.each([[""], ["   "], [null], [undefined], [new File([], "a")]])("留空或非字串（%s）轉成 NaN", (value) => {
    expect(toNumber(value)).toBeNaN();
  });

  it("非數字字串轉成 NaN，交給 App 驗證", () => {
    expect(toNumber("abc")).toBeNaN();
  });

  it("不判斷規則：負數與小數照轉", () => {
    expect(toNumber("-5")).toBe(-5);
    expect(toNumber("9.5")).toBe(9.5);
  });
});

describe("toText", () => {
  it("字串原樣回傳", () => {
    expect(toText(" 馬克杯 ")).toBe(" 馬克杯 ");
  });

  it("非字串（欄位不存在、檔案）轉成空字串", () => {
    expect(toText(null)).toBe("");
    expect(toText(new File([], "a"))).toBe("");
  });
});

describe("formToRecord", () => {
  it("轉成欄位名稱到字串的對照，供驗證失敗時回填", () => {
    const form = new FormData();
    form.set("name", "馬克杯");
    form.set("priceTwd", "0");

    expect(formToRecord(form)).toEqual({ name: "馬克杯", priceTwd: "0" });
  });
});
