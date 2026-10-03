import { expect, test, type Page } from "@playwright/test";
import { adminAccessHeaders } from "../harness/admin-access";
import { unlistProduct, seedListedProducts } from "../harness/admin-seed";
import { BASE_URL } from "../harness/constants";
import { createCustomer } from "../harness/customer-fixture";
import { memberSessionCookie } from "../harness/session-cookie";
import { analyzeWhenSettled } from "../harness/axe";

async function assertLayout(page: Page, width: number) {
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
  test(`${viewport.name}：管理員記錄配送失敗、再次配送與送達，顧客查看進度，失敗不退款`, async ({ browser }) => {
    test.setTimeout(300_000);
    const suffix = `${viewport.width}`;
    const productName = `送達檯燈${suffix}`;
    const adminContext = await browser.newContext({ baseURL: BASE_URL, extraHTTPHeaders: adminAccessHeaders(), viewport });
    const [productId] = await seedListedProducts(adminContext, { slug: `delivery-${suffix}`, name: `送達分類${suffix}`, description: "送達測試" }, [
      { name: productName, priceTwd: 1000, stock: 4 },
    ]) as [number];
    const customer = createCustomer("送達顧客", `delivery-${suffix}@example.com`);
    const customerContext = await browser.newContext({ baseURL: BASE_URL, viewport });
    await customerContext.addCookies([memberSessionCookie({ token: customer.token })]);
    const admin = await adminContext.newPage();
    const page = await customerContext.newPage();
    try {
      await page.goto(`/products/${productId}`);
      await page.getByRole("region", { name: "商品資訊" }).getByRole("button", { name: "加入購物車", exact: true }).click();
      await expect(page.locator("#cart-count")).not.toHaveText("0");
      await page.goto("/checkout");
      await page.getByLabel("收件人姓名").fill("送達王");
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
      await admin.getByRole("button", { name: "確認交運這一批" }).click();
      await expect(admin.getByRole("status")).toHaveText("已記錄這一批出貨。");
      const batches = admin.getByRole("list", { name: "出貨批次" });
      await expect(batches).toContainText("配送進度：運送中");

      // 表單時間到秒：每筆回報前等到下一秒，截斷後的時間才不早於交運時間，三筆時間也遞增

      const report = async (kind: string) => {
        await admin.waitForTimeout(1_000 - (Date.now() % 1_000) + 50);
        // 配送失敗時清單預設展開，其餘收合：只在收合時點開
        if (!(await batches.locator("details.shipment-events").evaluate((element: HTMLDetailsElement) => element.open))) await batches.getByText(/^物流回報/).click();
        await batches.getByLabel("回報種類").selectOption(kind);
        await batches.getByLabel(/回報發生時間/).fill(taipeiLocalNow());
        await batches.getByRole("button", { name: "記錄物流回報" }).click();
        await expect(admin).toHaveURL(/saved=event/);
        await expect(admin.getByRole("status")).toHaveText("已記錄物流回報。");
        await admin.goto(`/admin/orders/${orderId}`);
      };

      await report("delivery_failed");
      await expect(batches).toContainText("配送進度：配送未成功，等待再次配送");
      await expect(batches).toContainText("通知已建立");
      await assertLayout(admin, viewport.width);

      await page.goto(`/orders/${orderId}`);
      await expect(page.getByRole("list", { name: "出貨批次" })).toContainText("配送未成功，等待再次配送");

      await admin.goto(`/admin/orders/${orderId}`);
      await report("redelivery");
      await expect(batches).toContainText("配送進度：運送中");
      await report("delivered");
      await expect(batches).toContainText("配送進度：已送達（實際送達：");
      await expect(admin.getByText("訂單狀態：已出貨")).toBeVisible();
      await expect(batches).toContainText("第 1 批");
      await expect(admin.getByText("未交運")).toHaveCount(0);
      await assertLayout(admin, viewport.width);

      // 顧客看到已送達、沒有退款、批次數不變；在庫只扣過一次（一筆交運流水）
      await page.goto(`/orders/${orderId}`);
      await expect(page.getByRole("list", { name: "出貨批次" })).toContainText("已送達（實際送達：");
      // 已出貨的訂單有退貨申請入口（#117，說明文字會提到退款），所以斷言沒有退款進度與退款紀錄，而不是頁面完全沒有「退款」二字
      await expect(page.getByRole("region", { name: "退款進度" })).toHaveCount(0);
      await expect(page.getByText("已退款")).toHaveCount(0);
      await expect(page.getByText("退款處理中")).toHaveCount(0);
      await assertLayout(page, viewport.width);
      await admin.goto(`/admin/stock-movements?orderId=${orderId}`);
      await expect(admin.getByRole("row").filter({ hasText: "交運扣庫" })).toHaveCount(1);
    } finally {
      await unlistProduct(adminContext.request, productId);
      await adminContext.close();
      await customerContext.close();
    }
  });
}
