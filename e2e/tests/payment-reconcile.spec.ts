import { expect, test, type Page } from "@playwright/test";
import { adminAccessHeaders } from "../harness/admin-access";
import { unlistProduct, seedListedProducts } from "../harness/admin-seed";
import { BASE_URL } from "../harness/constants";
import { createCustomer } from "../harness/customer-fixture";
import { memberSessionCookie } from "../harness/session-cookie";
import { analyzeWhenSettled } from "../harness/axe";
import { expectNothingOmitted } from "../harness/admin-list";

/** 無水平捲動、主要區域的操作元件至少 44px、無 axe 違規。 */
async function assertLayout(page: Page, width: number) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth), "page overflow").toBeLessThanOrEqual(width);
  for (const control of await page.locator("main :is(a, button, input):not([role=status] a)").all()) {
    if (!(await control.isVisible())) continue;
    const box = await control.boundingBox();
    if (box) expect(box.height, `${await control.textContent()} 高度`).toBeGreaterThanOrEqual(44);
  }
  expect((await analyzeWhenSettled(page)).violations).toEqual([]);
}

for (const viewport of [{ name: "手機", width: 375, height: 812 }, { name: "桌機", width: 1280, height: 900 }]) {
  test(`${viewport.name}：顧客付款後關窗、通知遺失，管理員補查後訂單轉已付款並補齊通知；顧客不能看補查頁`, async ({ browser }) => {
    test.setTimeout(300_000);
    const suffix = `${viewport.width}`;
    const adminContext = await browser.newContext({ baseURL: BASE_URL, extraHTTPHeaders: adminAccessHeaders(), viewport });
    const [productId] = await seedListedProducts(adminContext, { slug: `reconcile-${suffix}`, name: `補查分類${suffix}`, description: "補查測試" }, [
      { name: `補查檯燈${suffix}`, priceTwd: 800, stock: 4 },
    ]) as [number];
    const customer = createCustomer("補查顧客", `reconcile-${suffix}@example.com`);
    const customerContext = await browser.newContext({ baseURL: BASE_URL, viewport });
    await customerContext.addCookies([memberSessionCookie({ token: customer.token })]);
    const admin = await adminContext.newPage();
    const page = await customerContext.newPage();
    try {
      await page.goto(`/products/${productId}`);
      await page.getByRole("region", { name: "商品資訊" }).getByRole("button", { name: "加入購物車", exact: true }).click();
      await expect(page.locator("#cart-count")).toHaveText("1");
      await page.goto("/checkout");
      await page.getByLabel("收件人姓名").fill("補查王");
      await page.getByLabel("收件人電話").fill("0912345678");
      await page.getByLabel("收件地址").fill("台北市中正區重慶南路一段 122 號");
      await page.getByLabel(/我確認配送地點位於台灣本島/).check();
      await page.getByRole("button", { name: "送出訂單" }).click();
      await expect(page).toHaveURL(/\/orders\/(\d+)\?placed=1$/);
      const orderId = /\/orders\/(\d+)/.exec(page.url())![1]!;

      // 閘道已收款，但 webhook 延後不送、顧客也沒被導回（關窗）：本站不知道付款成功
      await page.getByRole("button", { name: "前往付款", exact: true }).click();
      await page.getByRole("radio", { name: "成功", exact: true }).check();
      await page.getByRole("radio", { name: "延遲回呼" }).check();
      await page.getByRole("checkbox", { name: /不導回/ }).check();
      await page.getByRole("button", { name: "送出", exact: true }).click();
      await expect(page.getByText("付款已完成，您可以關閉此頁。")).toBeVisible();
      await page.goto(`/orders/${orderId}`);
      await expect(page.getByText("訂單狀態：待付款")).toBeVisible();

      // 管理員在補查頁看到這筆待查證的付款，補查後訂單轉已付款
      await admin.goto("/admin/payments");
      await expectNothingOmitted(admin);
      await expect(admin.getByRole("heading", { level: 1, name: "付款補查" })).toBeVisible();
      const row = admin.getByRole("row").filter({ has: admin.getByRole("link", { name: `#${orderId}`, exact: true }) });
      await expect(row).toContainText("尚未發現問題");
      await assertLayout(admin, viewport.width);
      await row.getByRole("button", { name: /補查付款/ }).click();
      await expect(admin.getByRole("status")).toContainText("已補查並套用閘道的付款結果");
      await expect(admin.getByRole("row").filter({ has: admin.getByRole("link", { name: `#${orderId}`, exact: true }) })).toHaveCount(0);
      await assertLayout(admin, viewport.width);

      // 顧客的進度與通知一致
      await page.goto(`/orders/${orderId}`);
      await expect(page.getByText("訂單狀態：已付款")).toBeVisible();
      await page.goto("/account/mailbox");
      await expect(page.getByRole("link", { name: `訂單 #${orderId} 付款成功` })).toBeVisible();
      await assertLayout(page, viewport.width);

      // 顧客沒有管理員身分，看不到補查頁
      const forbidden = await customerContext.request.get("/admin/payments", { maxRedirects: 0 });
      expect(forbidden.status()).not.toBe(200);
    } finally {
      await unlistProduct(adminContext.request, productId);
      await adminContext.close();
      await customerContext.close();
    }
  });
}
