import { expect, test, type Page } from "@playwright/test";
import { adminAccessHeaders } from "../harness/admin-access";
import { analyzeWhenSettled } from "../harness/axe";
import { BASE_URL } from "../harness/constants";
import { createCustomer, writeFixture } from "../harness/customer-fixture";

const viewports = [{ width: 1280, height: 900 }, { width: 375, height: 800 }];
const orderLinks = (page: Page) => page.getByRole("region", { name: "管理資料表" }).getByRole("link", { name: /^#\d+$/ });
const listedIds = async (page: Page) => (await orderLinks(page).allTextContents()).map(value => Number(value.slice(1)));
async function expectRestoredFilters(page: Page, customerId: string, day: string, ids: number[]) {
  await expect(page.getByLabel("顧客 email")).toHaveValue(customerId);
  await expect(page.getByLabel("訂單狀態")).toHaveValue("paid");
  await expect(page.getByLabel("成立日期（起）")).toHaveValue(day);
  await expect(page.getByLabel("成立日期（迄）")).toHaveValue(day);
  await expect(orderLinks(page)).toHaveCount(ids.length);
  expect(await listedIds(page)).toEqual(ids);
}

for (const viewport of viewports) {
  test(`訂單列表返回保留篩選、游標與備註操作（${viewport.width}px）`, async ({ browser }) => {
    test.setTimeout(180_000);
    const context = await browser.newContext({ baseURL: BASE_URL, extraHTTPHeaders: adminAccessHeaders(), viewport });
    try {
      const customer = createCustomer(`列表返回 ${viewport.width}`);
      const now = Date.now();
      // 只查本日，避免其他案例後插入的歷史訂單改變日期查找的編號邊界。
      const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
      const key = crypto.randomUUID();
      // 日期篩選依成立時間與訂單 ID 同序定位邊界；控制單要比先寫入的 25 筆晚。
      writeFixture(`INSERT INTO orders (customer_id, status, total_twd, shipping_name, shipping_phone, shipping_address, payment_deadline, created_at, idempotency_key, request_hash)
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 25)
        SELECT '${customer.id}', 'paid', 100, '收件人', '0912345678', '台北市', ${now + 86400000}, ${now} + i, 'e2e-return-${key}-' || i, 'h' FROM n;
        INSERT INTO orders (customer_id, status, total_twd, shipping_name, shipping_phone, shipping_address, payment_deadline, created_at, idempotency_key, request_hash)
        VALUES ('${customer.id}', 'expired', 100, '收件人', '0912345678', '台北市', ${now + 86400000}, ${now + 26}, 'e2e-return-control-${key}', 'h');`);

      const page = await context.newPage();
      await page.goto("/admin/orders");
      await page.getByLabel("顧客 email").fill(customer.id);
      await page.getByLabel("訂單狀態").selectOption("paid");
      await page.getByLabel("成立日期（起）").fill(day);
      await page.getByLabel("成立日期（迄）").fill(day);
      await page.getByRole("button", { name: "查找" }).click();
      await expect(orderLinks(page)).toHaveCount(20);
      expect(await listedIds(page)).toHaveLength(20);
      await page.getByRole("link", { name: /下一頁/ }).click();
      await expect(orderLinks(page)).toHaveCount(5);
      const listUrl = new URL(page.url());
      expect(listUrl.searchParams.get("before")).toMatch(/^\d+$/);
      expect(listUrl.searchParams.get("email")).toBe(customer.id);
      expect(listUrl.searchParams.get("status")).toBe("paid");
      expect(listUrl.searchParams.get("from")).toBe(day);
      expect(listUrl.searchParams.get("to")).toBe(day);
      const secondPage = await listedIds(page);
      expect(secondPage).toHaveLength(5);
      const orderId = secondPage[0];
      await page.getByRole("region", { name: "管理資料表" }).getByRole("link", { name: `#${orderId}` }).click();
      const detailUrl = new URL(page.url());
      expect(detailUrl.searchParams.get("returnTo")).toBe(`${listUrl.pathname}${listUrl.search}`);
      const breadcrumb = page.getByRole("navigation", { name: "麵包屑" }).getByRole("link", { name: "訂單管理" });
      await expect(breadcrumb).toHaveAttribute("href", `${listUrl.pathname}${listUrl.search}`);
      await expect(page.getByRole("link", { name: /返回訂單管理/ })).toHaveAttribute("href", `${listUrl.pathname}${listUrl.search}`);
      await expect(page.getByRole("link", { name: "庫存流水", exact: true }).last()).toHaveAttribute("href", `/admin/stock-movements?orderId=${orderId}`);
      if (viewport.width === 375) {
        await page.getByRole("button", { name: "開啟後台選單" }).click();
        await expect(page.getByRole("dialog").getByRole("navigation", { name: "後台導覽" }).getByRole("link", { name: "訂單管理" })).toHaveAttribute("aria-current", "page");
        await page.keyboard.press("Escape");
      } else {
        await expect(page.getByRole("navigation", { name: "後台導覽" }).getByRole("link", { name: "訂單管理" }).first()).toHaveAttribute("aria-current", "page");
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
      expect((await analyzeWhenSettled(page)).violations).toEqual([]);
      await page.screenshot({ path: `/tmp/storefront-order-return-${viewport.width}.png`, fullPage: true });
      await breadcrumb.focus();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(listUrl.href);
      await expectRestoredFilters(page, customer.id, day, secondPage);

      await page.getByRole("region", { name: "管理資料表" }).getByRole("link", { name: `#${orderId}` }).click();
      await page.getByLabel("新增備註").fill(`返回測試 ${key}`);
      await page.getByRole("button", { name: "新增備註" }).click();
      await expect(page.getByRole("status").filter({ hasText: "已新增備註" })).toBeVisible();
      expect(new URL(page.url()).searchParams.get("returnTo")).toBe(`${listUrl.pathname}${listUrl.search}`);
      await page.getByRole("navigation", { name: "麵包屑" }).getByRole("link", { name: "訂單管理" }).click();
      await expect(page).toHaveURL(listUrl.href);
      await expectRestoredFilters(page, customer.id, day, secondPage);

      await page.getByRole("region", { name: "管理資料表" }).getByRole("link", { name: `#${orderId}` }).click();
      const noteForm = page.locator("form").filter({ has: page.getByRole("button", { name: "新增備註" }) });
      await noteForm.evaluate(form => form.setAttribute("novalidate", ""));
      await page.getByRole("button", { name: "新增備註" }).click();
      await expect(page.getByRole("alert")).toContainText("備註內容有誤");
      expect(new URL(page.url()).searchParams.get("returnTo")).toBe(`${listUrl.pathname}${listUrl.search}`);
      await expect(page.getByRole("navigation", { name: "麵包屑" }).getByRole("link", { name: "訂單管理" })).toHaveAttribute("href", `${listUrl.pathname}${listUrl.search}`);
      await page.getByRole("link", { name: /返回訂單管理/ }).click();
      await expect(page).toHaveURL(listUrl.href);
      await expectRestoredFilters(page, customer.id, day, secondPage);

      for (const invalid of ["https://example.com/admin/orders", "/admin/products?q=wrong", "/admin/orders?unknown=x", "//example.com/admin/orders"]) {
        await page.goto(`/admin/orders/${orderId}?returnTo=${encodeURIComponent(invalid)}`);
        await expect(page.getByRole("navigation", { name: "麵包屑" }).getByRole("link", { name: "訂單管理" })).toHaveAttribute("href", "/admin/orders");
        await expect(page.getByRole("link", { name: /返回訂單管理/ })).toHaveAttribute("href", "/admin/orders");
      }
      await page.goto(`/admin/orders/${orderId}`);
      await expect(page.getByRole("navigation", { name: "麵包屑" }).getByRole("link", { name: "訂單管理" })).toHaveAttribute("href", "/admin/orders");
    } finally {
      await context.close();
    }
  });
}
