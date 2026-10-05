import { expect, test, type Page } from "@playwright/test";
import { adminAccessHeaders } from "../harness/admin-access";
import { unlistProduct, seedListedProducts } from "../harness/admin-seed";
import { BASE_URL } from "../harness/constants";
import { createCustomer } from "../harness/customer-fixture";
import { memberSessionCookie } from "../harness/session-cookie";
import { analyzeWhenSettled } from "../harness/axe";

/** 既有的訂單頁有尺寸不足的控制項（不在這張票範圍）：只檢查無水平捲動與 axe 零違規。 */
async function assertNoOverflowAndAxe(page: Page, width: number) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth), "page overflow").toBeLessThanOrEqual(width);
  expect((await analyzeWhenSettled(page)).violations).toEqual([]);
}

/** 目前台北時間（到秒）的 `datetime-local` 值。 */
function taipeiLocalNow(): string {
  const value = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 19);
  // 秒數為 0 時 Chrome 把 datetime-local 正規化成 HH:MM，帶 :00 的值會被判為格式錯誤
  return value.endsWith(":00") ? value.slice(0, 16) : value;
}

for (const viewport of [{ name: "手機", width: 375, height: 812 }, { name: "桌機", width: 1280, height: 900 }]) {
  test(`${viewport.name}：未送達的批次只有人工受理；送達後顧客在窗口內自助申請，管理員看到自助申請；別的顧客看不到這張訂單`, async ({ browser }) => {
    test.setTimeout(300_000);
    const suffix = `${viewport.width}`;
    const productName = `自助退貨檯燈${suffix}`;
    const adminContext = await browser.newContext({ baseURL: BASE_URL, extraHTTPHeaders: adminAccessHeaders(), viewport });
    const [productId] = await seedListedProducts(adminContext, { slug: `self-return-${suffix}`, name: `自助退貨分類${suffix}`, description: "自助退貨測試" }, [
      { name: productName, priceTwd: 1000, stock: 6 },
    ]) as [number];
    const customer = createCustomer("自助退貨顧客", `self-return-${suffix}@example.com`);
    const other = createCustomer("其他顧客", `self-return-other-${suffix}@example.com`);
    const customerContext = await browser.newContext({ baseURL: BASE_URL, viewport });
    await customerContext.addCookies([memberSessionCookie({ token: customer.token })]);
    const otherContext = await browser.newContext({ baseURL: BASE_URL, viewport });
    await otherContext.addCookies([memberSessionCookie({ token: other.token })]);
    const admin = await adminContext.newPage();
    const page = await customerContext.newPage();
    page.on("dialog", (dialog) => void dialog.accept());
    admin.on("dialog", (dialog) => void dialog.accept());
    try {
      await page.goto(`/products/${productId}`);
      const info = page.getByRole("region", { name: "商品資訊" });
      for (let count = 0; count < 3; count += 1) {
        await info.getByRole("button", { name: "加入購物車", exact: true }).click();
        await expect(info.getByRole("status")).toHaveText(`已加入購物車，目前 ${count + 1} 件。`);
        await expect(page.locator("#cart-count")).toHaveText("1");
      }
      await page.goto("/checkout");
      await page.getByLabel("收件人姓名").fill("自助王");
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
      await admin.goto(`/admin/orders/${orderId}`);
      await admin.getByRole("button", { name: "確認交運這一批" }).click();
      await expect(admin.getByRole("status")).toContainText("已記錄這一批出貨");

      // 已交運但未送達：不能自助申請，指向人工受理，人工受理表單仍在
      await page.goto(`/orders/${orderId}`);
      const section = page.getByRole("region", { name: "退貨申請" });
      await expect(section.getByRole("list", { name: "各批自助退貨期限" })).toContainText("尚未送達");
      await expect(section.getByRole("button", { name: "送出自助退貨" })).toHaveCount(0);
      await expect(section.getByRole("button", { name: "申請退貨", exact: true })).toBeVisible();
      await assertNoOverflowAndAxe(page, viewport.width);

      // 管理員記錄送達（表單時間到秒：等到下一秒，截斷後的時間才不早於交運時間）
      await admin.goto(`/admin/orders/${orderId}`);
      await admin.waitForTimeout(1_000 - (Date.now() % 1_000) + 50);
      const batches = admin.getByRole("list", { name: "出貨批次" });
      await batches.getByText(/^物流回報/).click();
      await batches.getByLabel("回報種類").selectOption("delivered");
      await batches.getByLabel(/回報發生時間/).fill(taipeiLocalNow());
      await batches.getByRole("button", { name: "記錄物流回報" }).click();
      await expect(admin.getByRole("status")).toHaveText("已記錄物流回報。");

      // 送達後：窗口開放，顧客自助申請 2 件
      await page.goto(`/orders/${orderId}`);
      await expect(section).toContainText("可自助申請，至");
      await assertNoOverflowAndAxe(page, viewport.width);
      await section.getByLabel(new RegExp(`${productName}.*本批可自助退貨 3`)).fill("2");
      await section.getByLabel(/退貨原因（選填）/).fill("顏色不喜歡");
      await section.getByRole("button", { name: "送出自助退貨" }).click();
      await expect(page.getByRole("status").filter({ hasText: "已送出退貨申請" })).toBeVisible();
      const cases = page.getByRole("list", { name: "退貨申請紀錄" });
      await expect(cases).toContainText("待審核");
      await expect(cases).toContainText(`${productName} × 2`);
      await expect(section.getByLabel(new RegExp(`${productName}.*本批可自助退貨 1`))).toBeVisible();
      // 超量：本批只剩 1 件，數量欄位上限即是 1
      await expect(section.getByLabel(new RegExp(`${productName}.*本批可自助退貨 1`))).toHaveAttribute("max", "1");

      // 管理員在訂單頁看到這案是自助申請，核准後走既有流程
      await admin.goto(`/admin/orders/${orderId}`);
      await expect(admin.getByRole("list", { name: "退貨申請" })).toContainText("自助申請");
      await admin.getByRole("button", { name: "核准退貨" }).click();
      await expect(admin.getByRole("status")).toContainText("已核准這案退貨申請");
      await assertNoOverflowAndAxe(admin, viewport.width);

      // 別的顧客看不到這張訂單
      const otherPage = await otherContext.newPage();
      await otherPage.goto(`/orders/${orderId}`);
      await expect(otherPage.getByText("找不到這張訂單")).toBeVisible();
    } finally {
      await unlistProduct(adminContext.request, productId);
      await adminContext.close();
      await customerContext.close();
      await otherContext.close();
    }
  });
}
