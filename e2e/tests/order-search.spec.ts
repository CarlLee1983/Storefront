import { expect, test, type Page } from "@playwright/test";
import { adminAccessHeaders } from "../harness/admin-access";
import { BASE_URL } from "../harness/constants";
import { createCustomer, writeFixture } from "../harness/customer-fixture";
import { memberSessionCookie } from "../harness/session-cookie";
import { analyzeWhenSettled } from "../harness/axe";

const VIEWPORTS = [{ name: "桌機", width: 1280, height: 900 }, { name: "手機", width: 375, height: 800 }];
const DAY_MS = 86_400_000;
/** 一位顧客底下的訂單數：超過一頁（20 筆）才能驗證翻頁。 */
const RECENT_ORDERS = 24;

async function assertNoOverflowAndAxe(page: Page, width: number) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth), "page overflow").toBeLessThanOrEqual(width);
  expect((await analyzeWhenSettled(page)).violations).toEqual([]);
}

/** 目前列表上的訂單編號（依畫面順序）。 */
const listedIds = async (page: Page) => (await page.getByRole("region", { name: "管理資料表" }).getByRole("link", { name: /^#\d+$/ }).allTextContents()).map(text => Number(text.slice(1)));

for (const viewport of VIEWPORTS) {
  test(`${viewport.name}：條件查找、翻頁到最舊的單、匯出同範圍，並留下只有管理員看得到的備註`, async ({ browser }) => {
    test.setTimeout(180_000);
    const adminContext = await browser.newContext({ baseURL: BASE_URL, extraHTTPHeaders: adminAccessHeaders(), viewport });
    const customerContext = await browser.newContext({ baseURL: BASE_URL, viewport });
    try {
      const suffix = `${viewport.name === "桌機" ? "d" : "m"}${Date.now()}`;
      const customer = createCustomer(`查找${suffix}`);
      const email = `${customer.id}@members.storefront.invalid`;
      const now = Date.now();
      const longAgo = Date.parse("2021-05-20T10:00:00+08:00");
      // 舊單先寫入、編號最小：列表以編號遞減，它落在最後一頁
      writeFixture(`INSERT INTO orders (customer_id, status, total_twd, shipping_name, shipping_phone, shipping_address, payment_deadline, created_at, idempotency_key, request_hash) VALUES ('${customer.id}', 'expired', 100, '收件人', '0912345678', '台北市', ${longAgo + DAY_MS}, ${longAgo}, 'e2e-search-old', 'h');
        INSERT INTO orders (customer_id, status, total_twd, shipping_name, shipping_phone, shipping_address, payment_deadline, created_at, idempotency_key, request_hash)
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${RECENT_ORDERS}) SELECT '${customer.id}', 'paid', 100, '收件人', '0912345678', '台北市', ${now + DAY_MS}, ${now} + i, 'e2e-search-' || i, 'h' FROM n;`);
      const page = await adminContext.newPage();

      // 以 email 查找：第一頁 20 筆，下一頁接上其餘 5 筆（含 2021 年的舊單），不重複
      await page.goto("/admin/orders");
      await page.getByLabel("顧客 email").fill(customer.id);
      await page.getByRole("button", { name: "查找" }).click();
      await expect(page).toHaveURL(/email=/);
      const firstPage = await listedIds(page);
      expect(firstPage).toHaveLength(20);
      await assertNoOverflowAndAxe(page, viewport.width);
      await page.getByRole("link", { name: /下一頁/ }).click();
      const secondPage = await listedIds(page);
      expect(secondPage).toHaveLength(RECENT_ORDERS + 1 - 20);
      expect(new Set([...firstPage, ...secondPage]).size).toBe(RECENT_ORDERS + 1);
      expect(Math.max(...secondPage)).toBeLessThan(Math.min(...firstPage));
      await expect(page.getByRole("link", { name: /下一頁/ })).toHaveCount(0);
      await assertNoOverflowAndAxe(page, viewport.width);
      const oldestId = secondPage.at(-1)!;

      // 日期區間只找到舊單；編號只找到單筆；兩者都不受「最新 200 筆」限制
      await page.goto(`/admin/orders?email=${customer.id}&from=2021-05-20&to=2021-05-20`);
      expect(await listedIds(page)).toEqual([oldestId]);
      await page.goto(`/admin/orders?orderId=${firstPage[0]}`);
      expect(await listedIds(page)).toEqual([firstPage[0]]);
      await page.goto(`/admin/orders?email=${customer.id}&from=2021-05-21&to=2021-05-20`);
      await expect(page.getByRole("alert")).toContainText("輸入有誤");

      // 匯出：與列表同一份條件，UTF-8 BOM、標題列、每張訂單一列
      await page.goto(`/admin/orders?email=${customer.id}`);
      const exportHref = await page.getByRole("link", { name: "匯出 CSV" }).getAttribute("href");
      const exported = await adminContext.request.get(exportHref!);
      expect(exported.status()).toBe(200);
      expect(exported.headers()["content-type"]).toBe("text/csv; charset=utf-8");
      expect(exported.headers()["content-disposition"]).toContain("attachment");
      const bytes = await exported.body();
      expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
      const lines = bytes.toString("utf8").replace(/^﻿/, "").split("\r\n").filter(Boolean);
      expect(lines[0]).toMatch(/^訂單編號,成立時間,顧客 email/);
      expect(lines.slice(1, -1).map(line => Number(line.split(",")[0]))).toEqual([...firstPage, ...secondPage]);
      expect(lines.at(-1)).toBe(`# 共 ${RECENT_ORDERS + 1} 筆，匯出完成`);
      expect((await customerContext.request.get(exportHref!)).status()).toBe(403);

      // 客服備註：管理員新增並看到操作者與時間；顧客的訂單頁與列表看不到
      await page.goto(`/admin/orders/${oldestId}`);
      await page.getByLabel("新增備註").fill(`電話確認過地址 ${suffix}`);
      await page.getByRole("button", { name: "新增備註" }).click();
      await expect(page.getByRole("status").filter({ hasText: "已新增備註" })).toBeVisible();
      const notes = page.getByRole("list", { name: "客服備註" });
      await expect(notes).toContainText(`電話確認過地址 ${suffix}`);
      await expect(notes).toContainText("admin@");
      await assertNoOverflowAndAxe(page, viewport.width);
      await customerContext.addCookies([memberSessionCookie({ token: customer.token })]);
      const mine = await customerContext.request.get(`/orders/${oldestId}`);
      expect(await mine.text()).not.toContain(`電話確認過地址 ${suffix}`);
      expect((await customerContext.request.post(`/admin/orders/${oldestId}`, { form: { intent: "add-note", note: "偷寫" } })).status()).toBe(403);
    } finally {
      await adminContext.close();
      await customerContext.close();
    }
  });
}
