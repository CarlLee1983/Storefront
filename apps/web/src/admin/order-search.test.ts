import { describe, expect, it } from "vitest";
import { readCursor, readOrderSearch, searchQuery, searchToInput } from "./order-search";

const params = (query: string) => new URLSearchParams(query);

describe("readOrderSearch", () => {
  it("讀出各條件並去掉前後空白；沒填與空白都是空字串", () => {
    expect(readOrderSearch(params("orderId=12&email=%20alice%20&status=paid&from=2030-03-01&to="))).toEqual({ orderId: "12", email: "alice", status: "paid", from: "2030-03-01", to: "" });
    expect(readOrderSearch(params(""))).toEqual({ orderId: "", email: "", status: "", from: "", to: "" });
  });

  it("狀態不是六種之一就視為不篩選", () => {
    expect(readOrderSearch(params("status=mystery")).status).toBe("");
  });
});

describe("searchToInput", () => {
  it("只送有填的欄位，編號轉數字，游標一併帶入", () => {
    expect(searchToInput({ orderId: "12", email: "", status: "paid", from: "2030-03-01", to: "" }, 40)).toEqual({ orderId: 12, status: "paid", from: "2030-03-01", beforeId: 40 });
    expect(searchToInput({ orderId: "", email: "", status: "", from: "", to: "" })).toEqual({});
  });

  it("編號不是數字時送 NaN，交給 App 回報欄位錯誤", () => {
    expect(searchToInput({ orderId: "abc", email: "", status: "", from: "", to: "" })).toEqual({ orderId: Number.NaN });
  });
});

describe("searchQuery", () => {
  it("保留有填的條件，可附翻頁游標；特殊字元會編碼", () => {
    expect(searchQuery({ orderId: "", email: "a&b@x.com", status: "paid", from: "", to: "2030-03-31" })).toBe("email=a%26b%40x.com&status=paid&to=2030-03-31");
    expect(searchQuery({ orderId: "", email: "", status: "", from: "", to: "" }, 40)).toBe("before=40");
  });
});

describe("readCursor", () => {
  it.each([["before=40", 40], ["", undefined], ["before=0", undefined], ["before=-3", undefined], ["before=abc", undefined], ["before=1.5", undefined]])("%s → %s", (query, expected) => {
    expect(readCursor(params(query))).toBe(expected);
  });
});
