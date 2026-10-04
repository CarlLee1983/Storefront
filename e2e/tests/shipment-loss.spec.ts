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

for (const viewport of [{ name: "手機", width: 375, height: 812 }, { name: "桌機", width: 1280, height: 900 }]) {
  test(`${viewport.name}：管理員確認部分商品物流遺失，退款含該類運費、不回補庫存，顧客看得到結果與通知，遺失的數量不能再退貨`, async ({ browser }) => {
    test.setTimeout(300_000);
    const suffix = `${viewport.width}`;
    const lampName = `遺失檯燈${suffix}`;
    const adminContext = await browser.newContext({ baseURL: BASE_URL, extraHTTPHeaders: adminAccessHeaders(), viewport });
    const [lampId] = await seedListedProducts(adminContext, { slug: `loss-${suffix}`, name: `遺失分類${suffix}`, description: "遺失測試" }, [
      { name: lampName, priceTwd: 1000, stock: 8 },
    ]) as [number];
    const customer = createCustomer("遺失顧客", `loss-${suffix}@example.com`);
    const customerContext = await browser.newContext({ baseURL: BASE_URL, viewport });
    await customerContext.addCookies([memberSessionCookie({ token: customer.token })]);
    const admin = await adminContext.newPage();
    const page = await customerContext.newPage();
    admin.on("dialog", (dialog) => void dialog.accept());
    try {
      // 顧客下單 3 件、付款，管理員全部交運成一批
      await page.goto(`/products/${lampId}`);
      const info = page.getByRole("region", { name: "商品資訊" });
      for (let count = 0; count < 3; count += 1) await info.getByRole("button", { name: "加入購物車", exact: true }).click();
      await expect(page.locator("#cart-count")).not.toHaveText("0");
      await page.goto("/checkout");
      await page.getByLabel("收件人姓名").fill("遺失王");
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

      // 管理員確認其中 2 件遺失：沒填數量先被擋下，填了之後退 2 件商品款加一般配送原運費
      const batches = admin.getByRole("list", { name: "出貨批次" });
      await batches.getByText("確認遺失", { exact: true }).click();
      await batches.getByRole("button", { name: "確認遺失並退款" }).click();
      await expect(admin.getByRole("alert").filter({ hasText: "至少填一筆遺失數量" })).toBeVisible();
      await batches.getByText("確認遺失", { exact: true }).click();
      const lossForm = batches.locator("details.shipment-loss");
      await lossForm.getByLabel(new RegExp(`${lampName}.*本批 3`)).fill("2");
      await lossForm.getByLabel(/備註/).fill("物流查證遺失");
      await batches.getByRole("button", { name: "確認遺失並退款" }).click();
      await expect(admin.getByRole("status")).toContainText("已確認這批商品遺失");
      await expect(admin.getByRole("status")).toContainText("退款已成功退回");
      await expect(batches).toContainText("配送進度：已確認遺失，已辦理退款");
      const losses = admin.getByRole("list", { name: "確認遺失紀錄" });
      await expect(losses).toContainText(`${lampName} × 2`);
      await expect(losses).toContainText("應退商品款 NT$ 2,000、運費 NT$ 100");
      await expect(losses).toContainText("不回補庫存、不補寄");
      await expect(admin.getByRole("region", { name: "退款資料表" })).toContainText("物流確認遺失");
      await assertNoOverflowAndAxe(admin, viewport.width);

      // 沒有回補庫存：庫存流水只有交運扣庫
      await admin.goto(`/admin/stock-movements?orderId=${orderId}`);
      await expect(admin.getByRole("row").filter({ hasText: "交運扣庫" })).toHaveCount(1);

      // 顧客：遺失說明、退款與通知；遺失的 2 件不能再退貨，只剩 1 件
      await page.goto(`/orders/${orderId}`);
      const lossSection = page.getByRole("list", { name: "遺失紀錄" });
      await expect(lossSection).toContainText(`${lampName} × 2`);
      await expect(lossSection).toContainText("不會補寄");
      await expect(lossSection).toContainText("應退款 NT$ 2,100");
      await expect(page.getByRole("region", { name: "退款進度" })).toContainText("物流確認商品遺失");
      await expect(page.getByRole("region", { name: "退款進度" })).toContainText("已退回原付款方式");
      await expect(page.getByRole("region", { name: "退貨申請" }).getByLabel(new RegExp(`${lampName}.*可退貨 1`))).toBeVisible();
      await assertNoOverflowAndAxe(page, viewport.width);
      await page.goto("/account/mailbox");
      await expect(page.getByRole("link", { name: new RegExp(`訂單 #${orderId} 有商品確認在運送中遺失`) })).toBeVisible();
      await expect(page.getByRole("link", { name: new RegExp(`訂單 #${orderId} 已退款 NT\\$2100`) })).toBeVisible();

      // 顧客沒有管理員身分，不能操作確認遺失
      const forbidden = await customerContext.request.post(`/admin/orders/${orderId}`, { form: { intent: "confirm-loss", shipmentId: "1", lossKey: "x" }, headers: { origin: BASE_URL }, maxRedirects: 0 });
      expect(forbidden.status()).not.toBe(303);
      expect(forbidden.status()).not.toBe(200);
    } finally {
      await unlistProduct(adminContext.request, lampId);
      await adminContext.close();
      await customerContext.close();
    }
  });
}
