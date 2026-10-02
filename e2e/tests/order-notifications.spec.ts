import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { adminAccessHeaders } from "../harness/admin-access";
import { seedListedProducts } from "../harness/admin-seed";
import { BASE_URL } from "../harness/constants";
import { createCustomer } from "../harness/customer-fixture";
import { memberSessionCookie } from "../harness/session-cookie";

const VIEWPORTS = [{ name: "手機", width: 375, height: 812 }, { name: "桌機", width: 1280, height: 900 }] as const;

/** 無水平捲動、主要區域的操作元件至少 44px、無 axe 違規。 */
async function assertAccessibleLayout(page: Page, width: number) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth), "page overflow").toBeLessThanOrEqual(width);
  for (const control of await page.locator("main :is(a, button, input, select)").all()) {
    if (!(await control.isVisible())) continue;
    const box = await control.boundingBox();
    if (!box) continue;
    expect(box.height, `${await control.textContent()} 高度`).toBeGreaterThanOrEqual(44);
  }
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
}

async function customerPage(browser: Browser, token: string, viewport: { width: number; height: number }): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: BASE_URL, viewport });
  await context.addCookies([memberSessionCookie({ token })]);
  return { context, page: await context.newPage() };
}

for (const viewport of VIEWPORTS) {
  test(`${viewport.name}：下單通知投遞失敗不影響訂單，管理員在待辦重送後顧客收到信，別人看不到`, async ({ browser }) => {
    const suffix = `${viewport.width}`;
    const productName = `通知商品${suffix}`;
    const adminContext = await browser.newContext({ baseURL: BASE_URL, extraHTTPHeaders: adminAccessHeaders(), viewport });
    let productId: number | undefined;
    try {
      [productId] = await seedListedProducts(adminContext, { slug: `notice-${suffix}`, name: `通知分類${suffix}`, description: "通知測試" }, [{ name: productName, priceTwd: 500, stock: 3 }]);
    } catch (error) {
      await adminContext.close();
      throw error;
    }

    const customerName = `通知顧客${suffix}`;
    const customer = createCustomer(customerName, `notice-${suffix}@example.com`);
    const other = createCustomer(`旁人${suffix}`, `bystander-${suffix}@example.com`);
    const { context, page } = await customerPage(browser, customer.token, viewport);
    const otherSide = await customerPage(browser, other.token, viewport);
    const admin = await adminContext.newPage();
    try {
      // 投遞失敗演練開啟時下單：訂單照常成立，信箱沒有信
      await admin.goto("/admin/mail");
      await admin.getByRole("button", { name: "開啟投遞失敗" }).click();
      await expect(admin.getByRole("status")).toContainText("已更新投遞演練設定");

      await page.goto(`/products/${productId!}`);
      await page.getByRole("region", { name: "商品資訊" }).getByRole("button", { name: "加入購物車", exact: true }).click();
      await expect(page.locator("#cart-count")).toHaveText("1");
      await page.goto("/checkout");
      await page.getByLabel("收件人姓名").fill("通知王");
      await page.getByLabel("收件人電話").fill("0912345678");
      await page.getByLabel("收件地址").fill("台北市中正區重慶南路一段 122 號");
      await page.getByRole("button", { name: "送出訂單" }).click();
      await expect(page).toHaveURL(/\/orders\/(\d+)\?placed=1$/);
      await page.goto("/account/mailbox");
      await expect(page.getByRole("heading", { name: "信箱還是空的" })).toBeVisible();

      // 管理端待辦：標出待處理，留有失敗的投遞與實際收件地址
      await admin.goto("/admin/mail");
      const row = admin.locator("tbody tr").filter({ hasText: customerName }).first();
      await expect(row).toContainText("待處理");
      await expect(row).toContainText("下單通知");
      await expect(row).toContainText(`notice-${suffix}@example.com：投遞失敗`);
      await assertAccessibleLayout(admin, viewport.width);

      // 關閉演練後重送：顧客收到信，待辦消失，處理人留在紀錄
      await admin.getByRole("button", { name: "關閉投遞失敗" }).click();
      await admin.locator("tbody tr").filter({ hasText: customerName }).first().getByRole("button", { name: /重送信件/ }).click();
      await expect(admin.getByRole("status")).toContainText("信件已送達顧客信箱");
      const resolved = admin.locator("tbody tr").filter({ hasText: customerName }).first();
      await expect(resolved).not.toContainText("待處理");
      await expect(resolved).toContainText("重送");

      await page.goto("/account/mailbox");
      await expect(page.locator(".mail-card")).toHaveCount(1);
      await expect(page.locator(".mail-card")).toContainText("下單通知");
      await assertAccessibleLayout(page, viewport.width);
      await page.locator(".mail-card").getByRole("link").click();
      await expect(page.getByText(/已成立，應付 NT\$500/)).toBeVisible();

      // 別人的信箱沒有這封信
      await otherSide.page.goto("/account/mailbox");
      await expect(otherSide.page.getByRole("heading", { name: "信箱還是空的" })).toBeVisible();
    } finally {
      // 失敗演練是全域狀態：不論成敗都關掉，不影響其他 spec
      await adminContext.request.post("/admin/mail", { form: { intent: "set-failure", enabled: "0" }, headers: { origin: BASE_URL }, maxRedirects: 0 });
      await context.close();
      await otherSide.context.close();
      await adminContext.close();
    }
  });
}
