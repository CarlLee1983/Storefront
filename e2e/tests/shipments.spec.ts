import { expect, test, type Page } from "@playwright/test";
import { adminAccessHeaders } from "../harness/admin-access";
import { unlistProduct, seedListedProducts } from "../harness/admin-seed";
import { BASE_URL } from "../harness/constants";
import { createCustomer } from "../harness/customer-fixture";
import { memberSessionCookie } from "../harness/session-cookie";
import { analyzeWhenSettled } from "../harness/axe";
import { addVariantQuantityFromDetail } from "../harness/cart";

async function assertLayout(page: Page, width: number) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth), "page overflow").toBeLessThanOrEqual(width);
  expect((await analyzeWhenSettled(page)).violations).toEqual([]);
}

for (const viewport of [{ name: "手機", width: 375, height: 812 }, { name: "桌機", width: 1280, height: 900 }]) {
  test(`${viewport.name}：管理員分兩批交運一般與大型配送（大型必填議定時段），訂單先部分出貨再已出貨，顧客逐批查看`, async ({ browser }) => {
    test.setTimeout(240_000);
    const suffix = `${viewport.width}`;
    const lampName = `分批燈具${suffix}`;
    const tableName = `分批餐桌${suffix}`;
    const adminContext = await browser.newContext({ baseURL: BASE_URL, extraHTTPHeaders: adminAccessHeaders(), viewport });
    const [lampId, tableId] = await seedListedProducts(adminContext, { slug: `shipments-${suffix}`, name: `分批分類${suffix}`, description: "分批出貨測試" }, [
      { name: lampName, priceTwd: 1000, stock: 6 },
      { name: tableName, priceTwd: 6000, stock: 2 },
    ]) as [number, number];
    const customer = createCustomer("分批顧客", `shipments-${suffix}@example.com`);
    const customerContext = await browser.newContext({ baseURL: BASE_URL, viewport });
    await customerContext.addCookies([memberSessionCookie({ token: customer.token })]);
    const admin = await adminContext.newPage();
    const page = await customerContext.newPage();
    try {
      await admin.goto(`/admin/products/${tableId}`);
      await admin.getByLabel("配送類型").selectOption({ label: "大型配送" });
      await admin.getByRole("button", { name: "儲存變更" }).click();
      await expect(admin).toHaveURL(/\/admin\/products\?saved=updated/);

      let expectedCount = 0;
      for (const [productId, quantity] of [[lampId, 2], [tableId, 1]] as const) {
        expectedCount += 1;
        await page.goto(`/products/${productId}`);
        await addVariantQuantityFromDetail(page, quantity, expectedCount);
      }
      await page.goto("/checkout");
      await page.getByLabel("收件人姓名").fill("分批王");
      await page.getByLabel("收件人電話").fill("0912345678");
      await page.getByLabel("收件地址").fill("台北市中正區重慶南路一段 122 號");
      await page.getByLabel(/我確認配送地點位於台灣本島/).check();
      await page.getByRole("button", { name: "送出訂單" }).click();
      await expect(page).toHaveURL(/\/orders\/(\d+)\?placed=1$/);
      const orderId = /\/orders\/(\d+)/.exec(page.url())![1]!;
      await page.getByRole("button", { name: "前往付款", exact: true }).click();
      await page.getByRole("radio", { name: "成功", exact: true }).check();
      await page.getByRole("radio", { name: "立即回呼", exact: true }).check();
      await page.getByRole("button", { name: "送出", exact: true }).click();
      await expect(page.getByText("訂單狀態：已付款")).toBeVisible();

      admin.on("dialog", (dialog) => void dialog.accept());
      await admin.goto(`/admin/orders/${orderId}`);
      // 預設數量是全部未交運數量：含大型配送卻沒有時段，被擋下且訂單不動
      await admin.getByRole("button", { name: "確認交運這一批" }).click();
      await expect(admin.getByRole("alert")).toContainText("含大型配送商品的批次必須填寫與顧客議定的配送時段");
      await expect(admin.getByText("還沒有出貨批次。")).toBeVisible();

      // 第一批：只出燈具（把餐桌數量改為 0），不帶時段
      await admin.getByLabel(new RegExp(`${tableName}.*未交運 1`)).fill("0");
      await admin.getByLabel("物流單號（可留空）").fill("STD-001");
      await admin.getByRole("button", { name: "確認交運這一批" }).click();
      await expect(admin.getByRole("status")).toHaveText("已記錄這一批出貨。");
      await expect(admin.getByText("訂單狀態：部分出貨")).toBeVisible();
      const batches = admin.getByRole("list", { name: "出貨批次" });
      await expect(batches).toContainText("第 1 批");
      await expect(batches).toContainText(`${lampName} × 2`);
      await expect(batches).toContainText("物流單號：STD-001");
      await assertLayout(admin, viewport.width);

      // 第二批：餐桌（大型配送），填議定時段
      await expect(admin.getByLabel(new RegExp(`${lampName}.*未交運`))).toHaveCount(0);
      await admin.getByLabel("物流單號（可留空）").fill("LRG-001");
      await admin.getByLabel("開始").fill("2026-10-10T09:00");
      await admin.getByLabel("結束").fill("2026-10-10T12:00");
      await admin.getByRole("button", { name: "確認交運這一批" }).click();
      await expect(admin.getByRole("status")).toHaveText("已記錄這一批出貨。");
      await expect(admin.getByText("訂單狀態：已出貨")).toBeVisible();
      await expect(admin.getByRole("button", { name: "確認交運這一批" })).toHaveCount(0);
      await expect(batches).toContainText("第 2 批");
      await expect(batches).toContainText(`${tableName} × 1（大型配送）`);
      await expect(batches).toContainText("議定配送時段：2026/10/10 09:00:00 至 2026/10/10 12:00:00（台北時間）");
      await assertLayout(admin, viewport.width);

      // 每批各寫流水
      await admin.goto(`/admin/stock-movements?orderId=${orderId}`);
      await expect(admin.getByRole("row").filter({ hasText: "交運扣庫" })).toHaveCount(2);

      // 顧客逐批查看，包含議定時段
      await page.goto(`/orders/${orderId}`);
      await expect(page.getByText("訂單狀態：已出貨")).toBeVisible();
      const customerBatches = page.getByRole("list", { name: "出貨批次" });
      await expect(customerBatches).toContainText("物流單號：STD-001");
      await expect(customerBatches).toContainText("物流單號：LRG-001");
      await expect(customerBatches).toContainText("議定配送時段");
      await assertLayout(page, viewport.width);
      await page.goto("/orders");
      await expect(page.getByRole("list", { name: "出貨批次" })).toContainText("第 2 批");
    } finally {
      for (const id of [lampId, tableId]) await unlistProduct(adminContext.request, id);
      await adminContext.close();
      await customerContext.close();
    }
  });
}
