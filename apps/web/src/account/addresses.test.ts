import { describe, expect, it } from "vitest";
import { addressFormToInput, describeAddressFailure, parseAddressId } from "./addresses";

describe("地址簿表單與文案", () => {
  it("表單原樣轉交欄位，非文字欄位視為空", () => {
    const form = new FormData();
    form.set("name", " 王小明 ");
    form.set("phone", "0912");
    expect(addressFormToInput(form)).toEqual({ name: " 王小明 ", phone: "0912", address: "" });
  });

  it("地址編號只接受正整數", () => {
    expect(parseAddressId("12")).toBe(12);
    for (const bad of [null, undefined, "0", "-1", "1.5", "abc", "01"]) expect(parseAddressId(bad)).toBeNull();
  });

  it("無效輸入顯示 App 的欄位訊息，已知原因顯示固定文案，未知原因與 prototype 代碼顯示通用訊息", () => {
    expect(describeAddressFailure({ reason: "invalid_input", fields: { name: ["收件人姓名不可為空"] } })).toBe("收件人姓名不可為空");
    expect(describeAddressFailure({ reason: "invalid_input" })).toContain("輸入有誤");
    expect(describeAddressFailure({ reason: "address_limit_reached" })).toContain("上限");
    expect(describeAddressFailure({ reason: "address_not_found" })).toContain("找不到");
    for (const reason of ["future_reason", "__proto__", "constructor"]) expect(describeAddressFailure({ reason })).toBe("目前無法完成操作，請稍後再試。");
  });
});
