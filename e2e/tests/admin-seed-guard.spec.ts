import { expect, test } from "@playwright/test";
import { adminAccessHeaders } from "../harness/admin-access";
import { BASE_URL } from "../harness/constants";
import { assertStorefrontAdmin } from "../seed/admin-ui";

test("seed guard accepts the actual product list", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: BASE_URL, extraHTTPHeaders: adminAccessHeaders() });
  try {
    await expect(assertStorefrontAdmin(await context.newPage(), BASE_URL)).resolves.toBeUndefined();
  } finally {
    await context.close();
  }
});

test("seed guard rejects a different page at the expected URL", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: BASE_URL });
  try {
    const page = await context.newPage();
    await page.route(`${BASE_URL}/admin`, route => route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><html><body><main><h1>商品管理</h1><p>Other application</p></main></body></html>",
    }));
    await expect(assertStorefrontAdmin(page, BASE_URL)).rejects.toThrow();
  } finally {
    await context.close();
  }
});

test("seed guard rejects a same-origin redirect away from the product list", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: BASE_URL });
  try {
    const page = await context.newPage();
    await page.route(`${BASE_URL}/admin`, route => route.fulfill({ status: 302, headers: { location: "/admin/orders" } }));
    await page.route(`${BASE_URL}/admin/orders`, route => route.fulfill({
      status: 200,
      contentType: "text/html",
      body: '<!doctype html><html><body><main><h1>商品管理</h1><nav aria-label="後台導覽"><a href="/admin" aria-current="page">商品管理</a></nav><a href="/admin/products/new">新增商品</a></main></body></html>',
    }));
    await expect(assertStorefrontAdmin(page, BASE_URL)).rejects.toThrow();
  } finally {
    await context.close();
  }
});
