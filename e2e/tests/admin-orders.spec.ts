import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { adminAccessHeaders } from "../harness/admin-access";
import { defaultVariantIds, seedListedProducts, unlistProductsByPrefix } from "../harness/admin-seed";
import { BASE_URL } from "../harness/constants";
import { memberSessionCookie } from "../harness/session-cookie";

const ROOT = resolve(import.meta.dirname, "../..");
const PREFIX = "訂單版面";
const EMAIL = `${"a".repeat(64)}@members.storefront.invalid`;
const NAMES = ["實木落地燈", "玻璃桌燈", "手工陶器", "閱讀單椅"].map(name => `${PREFIX}${name}`);

// Use the same E2E-only D1 state and Wrangler configuration that serve.ts creates.
function writeFixture(sql: string) {
  const config = resolve(ROOT, ".wrangler/e2e/app/wrangler.json");
  const database = JSON.parse(readFileSync(config, "utf8")).d1_databases[0].database_name as string;
  execFileSync("bunx", ["wrangler", "d1", "execute", database, "--local", "-c", config, "--persist-to", resolve(ROOT, ".wrangler/e2e/state-app"), "--command", sql], { cwd: resolve(ROOT, "apps/app"), stdio: "pipe" });
}

async function assertLayout(page: Page, width: number) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth), "page overflow").toBeLessThanOrEqual(width);
  for (const region of await page.getByRole("region", { name: /資料表/ }).all()) {
    const size = await region.evaluate(element => ({ width: element.clientWidth, scroll: element.scrollWidth }));
    expect(size.scroll, `table region overflow: ${await region.getAttribute("aria-label")}`).toBeLessThanOrEqual(size.width);
  }
  for (const control of await page.locator('main a, main button, main input, main select').all()) {
    const box = await control.boundingBox();
    if (!box) continue;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
}

test("四品項、長 email 與多筆付款在後台列表和明細完整可見", async ({ browser }, testInfo) => {
  test.setTimeout(180_000);
  const adminContext = await browser.newContext({ baseURL: BASE_URL, extraHTTPHeaders: adminAccessHeaders(), viewport: { width: 1280, height: 900 } });
  const customerContext = await browser.newContext({ baseURL: BASE_URL });
  const admin = await adminContext.newPage();
  const customer = await customerContext.newPage();
  try {
    const ids = await seedListedProducts(adminContext, { slug: "admin-orders-layout", name: PREFIX, description: "訂單版面測試" }, NAMES.map((name, index) => ({ name, priceTwd: (index + 1) * 680, stock: 5 })));
    const identity = crypto.randomUUID();
    const token = `admin-orders-${identity}`;
    const now = Date.now();
    writeFixture(`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES ('${identity}', '訂單版面顧客', '${EMAIL}', 0, ${now}, ${now}); INSERT INTO session (id, expires_at, token, created_at, updated_at, user_id) VALUES ('${identity}', ${now + 86_400_000}, '${token}', ${now}, ${now}, '${identity}');`);
    await customerContext.addCookies([memberSessionCookie({ token })]);
    await customer.goto("/cart");
    const variantIds = await defaultVariantIds(adminContext.request, ids);
    await customer.evaluate(({ ids, variantIds, names }) => localStorage.setItem("storefront.cart", JSON.stringify({ version: 2, lines: ids.map((productId, index) => ({ variantId: variantIds[index], productId, name: names[index], unitPriceTwd: (index + 1) * 680, quantity: index + 1 })) })), { ids, variantIds, names: NAMES });
    await customer.goto("/checkout");
    await customer.getByLabel("收件人姓名").fill("訂單版面顧客");
    await customer.getByLabel("收件人電話").fill("0912345678");
    await customer.getByLabel("收件地址").fill("台北市中正區測試地址");
    await customer.getByRole("button", { name: "送出訂單" }).click();
    await expect(customer).toHaveURL(/\/orders\/\d+\?placed=1$/);
    const orderId = new URL(customer.url()).pathname.split("/").pop()!;
    await customer.getByRole("button", { name: "前往付款", exact: true }).click();
    await customer.getByRole("radio", { name: "失敗", exact: true }).check();
    await customer.getByRole("radio", { name: "立即回呼", exact: true }).check();
    await customer.getByRole("button", { name: "送出", exact: true }).click();
    await expect(customer.getByText("訂單狀態：待付款")).toBeVisible();
    await customer.getByRole("button", { name: "前往付款", exact: true }).click();
    await customer.getByRole("radio", { name: "成功", exact: true }).check();
    await customer.getByRole("radio", { name: "立即回呼", exact: true }).check();
    await customer.getByRole("button", { name: "送出", exact: true }).click();
    await expect(customer.getByText("訂單狀態：已付款")).toBeVisible();
    // A failed refund is an operational state the UI must expose; keep the data in D1 so production queries derive needsAttention.
    writeFixture(`INSERT INTO payments (order_id, gateway_payment_id, amount_twd, status, created_at, expires_at, refund_reason, refund_at) VALUES (${orderId}, 'admin-orders-refund-${identity}', 20400, 'refund_failed', ${now}, ${now + 600000}, 'duplicate_success', ${now});`);

    for (const width of [1280, 375]) {
      await admin.setViewportSize({ width, height: 900 });
      await admin.goto("/admin/orders");
      const list = admin.getByRole("region", { name: "管理資料表" });
      const row = list.getByRole("row").filter({ has: admin.getByRole("link", { name: `#${orderId}`, exact: true }) });
      await expect(row).toContainText(EMAIL);
      await expect(row).toContainText("需要處理");
      await expect(row.locator(".order-products li")).toHaveCount(4);
      for (const name of NAMES) await expect(row.getByRole("img", { name: `${name}的封面` })).toBeVisible();
      const layout = await row.evaluate(element => ({ display: getComputedStyle(element).display, covers: [...element.querySelectorAll(".order-cover")].map(cover => {
        const box = cover.getBoundingClientRect();
        const label = cover.parentElement!.nextElementSibling!.getBoundingClientRect();
        return { width: box.width, height: box.height, sameLine: Math.abs(box.y + box.height / 2 - (label.y + label.height / 2)) < 12 };
      }) }));
      expect(layout.display).toBe(width === 375 ? "grid" : "table-row");
      for (const cover of layout.covers) { expect(cover.width).toBeGreaterThanOrEqual(40); expect(cover.width).toBeLessThanOrEqual(48); expect(cover.height).toBe(44); expect(cover.sameLine).toBe(true); }
      await assertLayout(admin, width);
      if (width === 1280) {
        const filter = (await admin.getByLabel("訂單狀態").boundingBox())!;
        const button = (await admin.getByRole("button", { name: "篩選" }).boundingBox())!;
        expect(button.y).toBe(filter.y);
      }
      await testInfo.attach(`orders-list-${width}`, { body: await admin.screenshot({ fullPage: true }), contentType: "image/png" });
      await row.getByRole("link", { name: `#${orderId}`, exact: true }).click();
      await expect(admin.locator(".admin-order-email")).toContainText(EMAIL);
      const lines = admin.getByRole("region", { name: "訂單明細資料表" });
      await expect(lines.getByRole("row")).toHaveCount(5);
      await expect(lines.locator("tbody td[data-label='數量']")).toHaveText(["1", "2", "3", "4"]);
      await expect(lines.locator("tbody td[data-label='小計']")).toHaveText(["NT$ 680", "NT$ 2,720", "NT$ 6,120", "NT$ 10,880"]);
      const payments = admin.getByRole("region", { name: "付款嘗試資料表" });
      await expect(payments.locator("tbody tr")).toHaveCount(3);
      await expect(payments).toContainText("需要處理");
      await assertLayout(admin, width);
      await testInfo.attach(`orders-detail-${width}`, { body: await admin.screenshot({ fullPage: true }), contentType: "image/png" });
    }
  } finally {
    await unlistProductsByPrefix(adminContext.request, PREFIX);
    await customerContext.close();
    await adminContext.close();
  }
});
