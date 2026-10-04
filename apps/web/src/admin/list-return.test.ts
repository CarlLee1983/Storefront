import { describe, expect, it } from "vitest";
import { adminListHref, readAdminListReturn, withListReturn } from "./list-return";

describe("admin list return", () => {
  it("retains product filters/page and strips operation notices", () => {
    const href = adminListHref("products", new URLSearchParams({ q: "桌燈 & 椅", status: "unlisted", category: "12", page: "2", saved: "updated", returnTo: "https://example.com" }));
    expect(href).toBe("/admin/products?q=%E6%A1%8C%E7%87%88+%26+%E6%A4%85&status=unlisted&category=12&page=2");
    expect(readAdminListReturn(href, "products")).toBe(href);
  });

  it("retains every order search field and the cursor", () => {
    const href = adminListHref("orders", new URLSearchParams({ orderId: "42", email: "a+b@example.com", status: "paid", from: "2026-01-01", to: "2026-10-04", before: "50", invoice: "issued" }));
    expect(href).toBe("/admin/orders?orderId=42&email=a%2Bb%40example.com&status=paid&from=2026-01-01&to=2026-10-04&before=50");
    expect(readAdminListReturn(href, "orders")).toBe(href);
  });

  for (const kind of ["products", "orders"] as const) {
    const base = `/admin/${kind}`;
    it(`${kind}: direct links and empty filters return to the default list`, () => {
      for (const raw of [null, "", base, `${base}?`, `${base}?status=`]) {
        expect(readAdminListReturn(raw, kind)).toBe(base);
      }
    });

    it.each([
      "https://example.com/admin/products", "//example.com/admin/orders", "/admin", "/admin/categories",
      `${base}/1`, `${base}/`, `${base}/../orders`, `${base}#heading`, `${base}?status=paid#heading`,
      `${base}?status=%`, `${base}?status=%xy`, `${base}?status=a\\b`, `${base}?status=a\nb`,
      `${base}?status=paid&status=expired`, `${base}?saved=updated`, `${base}?returnTo=/admin/orders`,
      kind === "products" ? "/admin/orders?before=10" : "/admin/products?page=2",
    ])(`${kind}: rejects invalid destination %s`, raw => {
      expect(readAdminListReturn(raw, kind)).toBe(base);
    });
  }

  it("retains redirect notice parameters and fragments without nesting state", () => {
    const returnTo = "/admin/orders?email=a%2Bb%40example.com&before=50";
    const href = withListReturn("/admin/orders/42?saved=return-inspected&refund=pending#returns", returnTo);
    const url = new URL(href, "https://storefront.invalid");
    expect(url.pathname).toBe("/admin/orders/42");
    expect(url.searchParams.get("saved")).toBe("return-inspected");
    expect(url.searchParams.get("refund")).toBe("pending");
    expect(url.searchParams.get("returnTo")).toBe(returnTo);
    expect(url.hash).toBe("#returns");
    expect(withListReturn(href, returnTo)).toBe(href);
  });

  it("does not change direct detail redirects without source filters", () => {
    expect(withListReturn("/admin/products/1?saved=variants#variants-heading", "/admin/products")).toBe("/admin/products/1?saved=variants#variants-heading");
  });
});
