import { expect, test, type Page } from "@playwright/test";
import { adminAccessHeaders } from "../harness/admin-access";
import { seedListedProducts } from "../harness/admin-seed";
import { BASE_URL } from "../harness/constants";
import { createCustomer } from "../harness/customer-fixture";
import { memberSessionCookie } from "../harness/session-cookie";
import { analyzeWhenSettled } from "../harness/axe";

// 費率是全域狀態：調整會讓同時進行的結帳 spec 金額失準，所以這支獨立成一個 project，等其他 spec 跑完才序列執行（見 playwright.config.ts）；結束前一定還原。

async function assertLayout(page: Page, width: number) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth), "page overflow").toBeLessThanOrEqual(width);
  expect((await analyzeWhenSettled(page)).violations).toEqual([]);
}

async function setRate(page: Page, label: string, amount: string) {
  const form = page.getByRole("form", { name: label });
  await form.getByLabel(new RegExp(`${label}（新台幣整數元）`)).fill(amount);
  await form.getByRole("button", { name: "儲存" }).click();
}

for (const viewport of [{ name: "手機", width: 375, height: 812 }, { name: "桌機", width: 1280, height: 900 }]) {
  test(`${viewport.name}：管理員調整費率只影響之後的訂單，舊單金額不變；一般顧客不能進入運費設定`, async ({ browser }) => {
    test.setTimeout(180_000);
    const adminContext = await browser.newContext({ baseURL: BASE_URL, extraHTTPHeaders: adminAccessHeaders(), viewport });
    const [lampId] = await seedListedProducts(adminContext, { slug: `rates-${viewport.width}`, name: `費率分類${viewport.width}`, description: "費率測試" }, [
      { name: `費率燈具${viewport.width}`, priceTwd: 1000, stock: 5 },
    ]) as [number];
    const customer = createCustomer("費率顧客", `rates-${viewport.width}@example.com`);
    const customerContext = await browser.newContext({ baseURL: BASE_URL, viewport });
    await customerContext.addCookies([memberSessionCookie({ token: customer.token })]);
    const admin = await adminContext.newPage();
    const page = await customerContext.newPage();
    const placeOrder = async () => {
      await page.goto(`/products/${lampId}`);
      await page.getByRole("region", { name: "商品資訊" }).getByRole("button", { name: "加入購物車", exact: true }).click();
      await expect(page.locator("#cart-count")).toHaveText("1");
      await page.goto("/checkout");
      await page.getByLabel("收件人姓名").fill("費率王");
      await page.getByLabel("收件人電話").fill("0912345678");
      await page.getByLabel("收件地址").fill("台北市中正區重慶南路一段 122 號");
      await page.getByLabel(/我確認配送地點位於台灣本島/).check();
      await page.getByRole("button", { name: "送出訂單" }).click();
      await expect(page).toHaveURL(/\/orders\/(\d+)\?placed=1$/);
      return /\/orders\/(\d+)/.exec(page.url())![1]!;
    };
    try {
      // 一般顧客（沒有 Access）進不了運費設定
      expect((await customerContext.request.get("/admin/shipping")).status()).toBe(403);

      await admin.goto("/admin/shipping");
      await expect(admin.getByRole("form", { name: "一般宅配運費" }).getByLabel(/運費/)).toHaveValue("100");
      await expect(admin.getByRole("form", { name: "大型配送運費" }).getByLabel(/運費/)).toHaveValue("600");
      await assertLayout(admin, viewport.width);

      const oldOrder = await placeOrder();
      await expect(page.locator(".order-total")).toContainText("NT$ 1,100");

      await setRate(admin, "一般宅配運費", "150");
      await expect(admin.getByRole("status")).toHaveText("已儲存運費。");
      await expect(admin.getByRole("form", { name: "一般宅配運費" }).getByLabel(/運費/)).toHaveValue("150");

      // 新單用新費率；舊單的運費與總額不變
      const newOrder = await placeOrder();
      expect(newOrder).not.toBe(oldOrder);
      await expect(page.locator(".order-total")).toContainText("NT$ 1,150");
      await page.goto(`/orders/${oldOrder}`);
      await expect(page.locator("dl.order-fees")).toContainText("一般宅配運費NT$ 100");
      await expect(page.locator(".order-total")).toContainText("NT$ 1,100");

      // 調為 0 即免運
      await setRate(admin, "一般宅配運費", "0");
      await expect(admin.getByRole("status")).toHaveText("已儲存運費。");
      await page.goto(`/products/${lampId}`);
      await page.getByRole("region", { name: "商品資訊" }).getByRole("button", { name: "加入購物車", exact: true }).click();
      await expect(page.locator("#cart-count")).toHaveText("1");
      await page.goto("/checkout");
      await expect(page.locator("#checkout-fee-standard-amount")).toHaveText("0");
      await expect(page.locator("#checkout-total")).toHaveText("1,000");
      await assertLayout(page, viewport.width);
    } finally {
      await setRate(admin, "一般宅配運費", "100");
      await admin.getByRole("status").waitFor();
      await customerContext.close();
      await adminContext.close();
    }
  });
}
