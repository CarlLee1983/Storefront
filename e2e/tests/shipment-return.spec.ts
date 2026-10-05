import { expect, test, type Page } from "@playwright/test";
import { adminAccessHeaders } from "../harness/admin-access";
import { unlistProduct, seedListedProducts } from "../harness/admin-seed";
import { BASE_URL } from "../harness/constants";
import { createCustomer } from "../harness/customer-fixture";
import { memberSessionCookie } from "../harness/session-cookie";
import { analyzeWhenSettled } from "../harness/axe";
import { addVariantQuantityFromDetail } from "../harness/cart";

/** 既有的訂單頁有尺寸不足的控制項（不在這張票範圍）：只檢查無水平捲動與 axe 零違規。 */
async function assertNoOverflowAndAxe(page: Page, width: number) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth), "page overflow").toBeLessThanOrEqual(width);
  expect((await analyzeWhenSettled(page)).violations).toEqual([]);
}

for (const viewport of [{ name: "手機", width: 375, height: 812 }, { name: "桌機", width: 1280, height: 900 }]) {
  test(`${viewport.name}：管理員登記物流退回、收回並檢查，退款含該類運費，庫存依收回與檢查變動，顧客看得到結果與通知，退回的數量不能再退貨`, async ({ browser }) => {
    test.setTimeout(300_000);
    const suffix = `${viewport.width}`;
    const lampName = `退回檯燈${suffix}`;
    const adminContext = await browser.newContext({ baseURL: BASE_URL, extraHTTPHeaders: adminAccessHeaders(), viewport });
    const [lampId] = await seedListedProducts(adminContext, { slug: `rts-${suffix}`, name: `退回分類${suffix}`, description: "物流退回測試" }, [
      { name: lampName, priceTwd: 1000, stock: 8 },
    ]) as [number];
    const customer = createCustomer("退回顧客", `rts-${suffix}@example.com`);
    const customerContext = await browser.newContext({ baseURL: BASE_URL, viewport });
    await customerContext.addCookies([memberSessionCookie({ token: customer.token })]);
    const admin = await adminContext.newPage();
    const page = await customerContext.newPage();
    admin.on("dialog", (dialog) => void dialog.accept());
    try {
      // 顧客下單 3 件、付款，管理員全部交運成一批
      await page.goto(`/products/${lampId}`);
      await addVariantQuantityFromDetail(page, 3, 1);
      await page.goto("/checkout");
      await page.getByLabel("收件人姓名").fill("退回王");
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

      // 登記物流退回：沒填數量先被擋下，填了之後批次進度成為退回，不動庫存與款項
      const batches = admin.getByRole("list", { name: "出貨批次" });
      const declareForm = batches.locator("details.shipment-return");
      await declareForm.locator("summary").click();
      await declareForm.getByRole("button", { name: "登記物流退回" }).click();
      await expect(admin.getByRole("alert").filter({ hasText: "至少填一筆退回數量" })).toBeVisible();
      await declareForm.locator("summary").click();
      await declareForm.getByLabel("退回數量").fill("2");
      await declareForm.getByLabel(/備註/).fill("物流退回單 R-1");
      await declareForm.getByRole("button", { name: "登記物流退回" }).click();
      await expect(admin.getByRole("status")).toContainText("已登記物流退回");
      await expect(batches).toContainText("配送進度：被物流退回倉庫，收到檢查後退款");
      const returns = admin.getByRole("list", { name: "物流退回紀錄" });
      await expect(returns).toContainText(`${lampName}`);
      await expect(returns).toContainText("退回 2");
      await expect(admin.getByRole("region", { name: "退款資料表" })).toHaveCount(0);

      // 記錄收回：實體在庫與不可售各加 2（待檢）
      await returns.getByLabel(new RegExp(`${lampName}.*登記退回 2`)).fill("2");
      await returns.getByRole("button", { name: "記錄收回" }).click();
      await expect(admin.getByRole("status")).toContainText("已記錄收回");

      // 記錄檢查：1 件良品、1 件損壞品，退 2 件商品款加一般配送原運費
      await returns.getByLabel("良品（轉可售）").fill("1");
      await returns.getByLabel("損壞品（隔離）").fill("1");
      await returns.getByRole("button", { name: "記錄檢查並退款" }).click();
      await expect(admin.getByRole("status")).toContainText("已記錄檢查");
      await expect(admin.getByRole("status")).toContainText("退款已成功退回");
      await expect(returns).toContainText("應退商品款 NT$ 2,000、運費 NT$ 100");
      await expect(returns).toContainText("良品 1、損壞 1");
      await expect(admin.getByRole("region", { name: "退款資料表" })).toContainText("物流退回檢查完成");
      await assertNoOverflowAndAxe(admin, viewport.width);

      // 庫存流水：交運扣庫、物流退回收回入倉、檢查合格轉可售
      await admin.goto(`/admin/stock-movements?orderId=${orderId}`);
      await expect(admin.getByRole("row").filter({ hasText: "交運扣庫" })).toHaveCount(1);
      await expect(admin.getByRole("row").filter({ hasText: "物流退回收回入倉" })).toHaveCount(1);
      await expect(admin.getByRole("row").filter({ hasText: "物流退回檢查合格轉可售" })).toHaveCount(1);

      // 顧客：物流退回說明、退款與通知；退回的 2 件不能再退貨，只剩 1 件
      await page.goto(`/orders/${orderId}`);
      const returnSection = page.getByRole("list", { name: "物流退回紀錄" });
      await expect(returnSection).toContainText(`${lampName} × 2`);
      await expect(returnSection).toContainText("不會從這張訂單補寄");
      await expect(returnSection).toContainText("應退款 NT$ 2,100");
      await expect(page.getByRole("region", { name: "退款進度" })).toContainText("物流退回的商品已收到並檢查完成");
      await expect(page.getByRole("region", { name: "退款進度" })).toContainText("已退回原付款方式");
      await expect(page.getByRole("region", { name: "退貨申請" }).getByLabel(new RegExp(`${lampName}.*可退貨 1`))).toBeVisible();
      await assertNoOverflowAndAxe(page, viewport.width);
      await page.goto("/account/mailbox");
      await expect(page.getByRole("link", { name: new RegExp(`訂單 #${orderId} 有商品被物流退回倉庫`) })).toBeVisible();
      await expect(page.getByRole("link", { name: new RegExp(`訂單 #${orderId} 被物流退回的商品已收到並檢查完成`) })).toBeVisible();
      await expect(page.getByRole("link", { name: new RegExp(`訂單 #${orderId} 已退款 NT\\$2100`) })).toBeVisible();

      // 顧客沒有管理員身分，不能操作物流退回
      const forbidden = await customerContext.request.post(`/admin/orders/${orderId}`, { form: { intent: "declare-return", shipmentId: "1", returnKey: "x" }, headers: { origin: BASE_URL }, maxRedirects: 0 });
      expect(forbidden.status()).not.toBe(303);
      expect(forbidden.status()).not.toBe(200);
    } finally {
      await unlistProduct(adminContext.request, lampId);
      await adminContext.close();
      await customerContext.close();
    }
  });
}
