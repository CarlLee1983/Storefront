import { describe, expect, it } from "vitest";
import { checkoutEntry } from "./entry";

const URL_CHECKOUT = new URL("https://storefront.example/checkout");

describe("checkoutEntry（結帳入口）", () => {
  it("未登入：導向登入頁，登入後回到 /checkout", () => {
    expect(checkoutEntry(null, URL_CHECKOUT)).toEqual({ kind: "redirect", location: "/login?next=%2Fcheckout" });
  });

  it("已登入：放行", () => {
    expect(checkoutEntry({ customerId: "c1", name: "Alice", expiresAt: 1 }, URL_CHECKOUT)).toEqual({ kind: "allow" });
  });
});
