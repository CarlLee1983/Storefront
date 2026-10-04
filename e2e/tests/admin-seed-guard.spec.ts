import { expect, test } from "@playwright/test";
import { adminAccessHeaders } from "../harness/admin-access";
import { BASE_URL } from "../harness/constants";
import { assertStorefrontAdmin } from "../seed/admin-ui";

for (const width of [375, 1280]) {
  test.describe(`seed guard ${width}px`, () => {
    const viewport = { width, height: 900 };
    test("seed guard accepts the actual product list", async ({ browser }) => {
      const context = await browser.newContext({ baseURL: BASE_URL, extraHTTPHeaders: adminAccessHeaders(), viewport });
      try {
        const page = await context.newPage();
        await expect(assertStorefrontAdmin(page, BASE_URL)).resolves.toBeUndefined();
        await expect(page.getByRole("heading", { name: "商品管理", level: 1, exact: true })).toBeVisible();
        await expect(page.getByRole("dialog", { name: "後台選單" })).not.toBeVisible();
      } finally {
        await context.close();
      }
    });

    test("seed guard rejects a different page at the expected URL", async ({ browser }) => {
      const context = await browser.newContext({ baseURL: BASE_URL, viewport });
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
      const context = await browser.newContext({ baseURL: BASE_URL, viewport });
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

    test("seed guard rejects a lookalike drawer with the wrong product link", async ({ browser }) => {
      const context = await browser.newContext({ baseURL: BASE_URL, viewport });
      try {
        const page = await context.newPage();
        await page.route(`${BASE_URL}/admin`, route => route.fulfill({
          status: 200,
          contentType: "text/html",
          body: `<!doctype html><html><body>
            <main><h1>商品管理</h1><a href="/admin/products/new">新增商品</a></main>
            <button aria-label="開啟後台選單" onclick="document.querySelector('dialog').showModal()">選單</button>
            <dialog aria-label="後台選單">
              <button aria-label="關閉後台選單" onclick="this.closest('dialog').close()">關閉</button>
              <nav aria-label="後台導覽"><a href="/admin/orders" aria-current="page">商品管理</a></nav>
            </dialog>
          </body></html>`,
        }));
        await expect(assertStorefrontAdmin(page, BASE_URL)).rejects.toThrow("不是 Storefront 的商品管理頁");
        await expect(page.getByRole("dialog", { name: "後台選單" })).not.toBeVisible();
      } finally {
        await context.close();
      }
    });
  });
}
