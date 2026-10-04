import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { adminAccessHeaders } from "../harness/admin-access";
import { seedListedProducts } from "../harness/admin-seed";
import { BASE_URL } from "../harness/constants";
import { createCustomer } from "../harness/customer-fixture";
import { memberSessionCookie } from "../harness/session-cookie";
import { analyzeWhenSettled } from "../harness/axe";

const VIEWPORTS = [{ name: "手機", width: 375, height: 812 }, { name: "桌機", width: 1280, height: 900 }] as const;

/** 無水平捲動、無 axe 違規（核取方塊以外的操作元件 44px 由全站樣式保證，這裡只驗結帳新增的核取列）。 */
async function assertLayout(page: Page, width: number) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth), "page overflow").toBeLessThanOrEqual(width);
  expect((await analyzeWhenSettled(page)).violations).toEqual([]);
}

async function customerPage(browser: Browser, token: string, viewport: { width: number; height: number }): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: BASE_URL, viewport });
  await context.addCookies([memberSessionCookie({ token })]);
  return { context, page: await context.newPage() };
}

async function addToCart(page: Page, productId: number, quantity: number) {
  await page.goto(`/products/${productId}`);
  const info = page.getByRole("region", { name: "商品資訊" });
  for (let count = 0; count < quantity; count += 1) await info.getByRole("button", { name: "加入購物車", exact: true }).click();
  await expect(page.locator("#cart-count")).not.toHaveText("0");
}

async function fillShipping(page: Page) {
  await page.getByLabel("收件人姓名").fill("運費王");
  await page.getByLabel("收件人電話").fill("0912345678");
  await page.getByLabel("收件地址").fill("台北市中正區重慶南路一段 122 號");
}

for (const viewport of VIEWPORTS) {
  test(`${viewport.name}：管理員設定大型配送，顧客結帳看到兩類運費與總額，訂單與後台保留快照`, async ({ browser }) => {
    test.setTimeout(180_000);
    const suffix = `${viewport.width}`;
    const lampName = `運費燈具${suffix}`;
    const tableName = `運費餐桌${suffix}`;
    const adminContext = await browser.newContext({ baseURL: BASE_URL, extraHTTPHeaders: adminAccessHeaders(), viewport });
    const [lampId, tableId] = await seedListedProducts(adminContext, { slug: `shipping-${suffix}`, name: `運費分類${suffix}`, description: "運費測試" }, [
      { name: lampName, priceTwd: 1000, stock: 6 },
      { name: tableName, priceTwd: 6000, stock: 2 },
    ]) as [number, number];

    const customer = createCustomer("運費顧客", `shipping-${suffix}@example.com`);
    const { context, page } = await customerPage(browser, customer.token, viewport);
    const admin = await adminContext.newPage();
    try {
      // 管理員把餐桌的變體設為大型配送
      await admin.goto(`/admin/products/${tableId}`);
      await expect(admin.getByLabel("配送類型")).toHaveValue("standard");
      await admin.getByLabel("配送類型").selectOption({ label: "大型配送" });
      await admin.getByRole("button", { name: "儲存變更" }).click();
      await expect(admin).toHaveURL(/\/admin\?saved=updated/);
      await admin.goto(`/admin/products/${tableId}`);
      await expect(admin.getByLabel("配送類型")).toHaveValue("large");
      // 圖庫腳本載入前上傳按鈕是停用的（停用狀態的對比不在此檢查範圍）：等它就緒再掃描
      await expect(admin.getByRole("button", { name: "上傳商品圖片" })).toBeEnabled();
      await admin.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished)));
      await assertLayout(admin, viewport.width);

      // 混合結帳：一般宅配與大型配送各收一次，燈具三件不按件加收
      await addToCart(page, lampId, 3);
      await addToCart(page, tableId, 1);
      await page.goto("/checkout");
      await expect(page.locator("#checkout-total")).toHaveText("9,700");
      await expect(page.locator("#checkout-fee-standard")).toContainText("一般宅配運費");
      await expect(page.locator("#checkout-fee-standard-amount")).toHaveText("100");
      await expect(page.locator("#checkout-fee-large")).toContainText("大型配送運費");
      await expect(page.locator("#checkout-fee-large-amount")).toHaveText("600");
      await expect(page.locator("#checkout-subtotal")).toHaveText("9,000");
      await expect(page.getByText("配送範圍限台灣本島")).toBeVisible();
      await fillShipping(page);
      await assertLayout(page, viewport.width);
      // 沒確認配送範圍就不能送出（瀏覽器的必填檢查擋下）
      await page.getByRole("button", { name: "送出訂單" }).click();
      await expect(page).toHaveURL(/\/checkout$/);
      await page.getByLabel(/我確認配送地點位於台灣本島/).check();
      await page.getByRole("button", { name: "送出訂單" }).click();
      await expect(page).toHaveURL(/\/orders\/(\d+)\?placed=1$/);
      const orderId = /\/orders\/(\d+)/.exec(page.url())![1]!;

      // 訂單頁：明細的配送類型、各類運費與總額
      await expect(page.getByRole("list", { name: "訂單明細" })).toContainText("配送：大型配送");
      const fees = page.getByRole("list", { name: "金額明細" }).or(page.locator("dl.order-fees"));
      await expect(fees).toContainText("商品小計NT$ 9,000");
      await expect(fees).toContainText("一般宅配運費NT$ 100");
      await expect(fees).toContainText("大型配送運費NT$ 600");
      await expect(page.locator(".order-total")).toContainText("NT$ 9,700");
      await assertLayout(page, viewport.width);

      // 後台訂單明細：配送類型欄與同樣的金額
      await admin.goto(`/admin/orders/${orderId}`);
      await expect(admin.getByRole("columnheader", { name: "配送類型" })).toBeVisible();
      await expect(admin.getByRole("region", { name: "訂單明細資料表" })).toContainText("大型配送");
      await expect(admin.locator("dl.order-fees")).toContainText("大型配送運費NT$ 600");
      await expect(admin.locator(".order-total")).toContainText("NT$ 9,700");
      await assertLayout(admin, viewport.width);

      // 只買一般宅配：同類多件只收一次，沒有大型運費列
      await addToCart(page, lampId, 2);
      await page.goto("/checkout");
      await expect(page.locator("#checkout-total")).toHaveText("2,100");
      await expect(page.locator("#checkout-fee-large")).toBeHidden();
      await expect(page.locator("#checkout-fee-standard-amount")).toHaveText("100");
    } finally {
      await context.close();
      await adminContext.close();
    }
  });
}
