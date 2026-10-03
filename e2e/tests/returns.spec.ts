import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { adminAccessHeaders } from "../harness/admin-access";
import { unlistProduct, seedListedProducts } from "../harness/admin-seed";
import { BASE_URL } from "../harness/constants";
import { createCustomer } from "../harness/customer-fixture";
import { memberSessionCookie } from "../harness/session-cookie";

/** 既有的訂單頁（返回連結、交運按鈕等）有尺寸不足的控制項（不在這張票範圍）：只檢查無水平捲動與 axe 零違規。 */
async function assertNoOverflowAndAxe(page: Page, width: number) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth), "page overflow").toBeLessThanOrEqual(width);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
}

for (const viewport of [{ name: "手機", width: 375, height: 812 }, { name: "桌機", width: 1280, height: 900 }]) {
  test(`${viewport.name}：顧客申請退貨，管理員審核、記錄收回與檢查（良品轉可售、損壞品隔離再報廢），按實付單價退款，雙方查得到各階段與通知`, async ({ browser }) => {
    test.setTimeout(300_000);
    const suffix = `${viewport.width}`;
    const lampName = `退貨檯燈${suffix}`;
    const adminContext = await browser.newContext({ baseURL: BASE_URL, extraHTTPHeaders: adminAccessHeaders(), viewport });
    const [lampId] = await seedListedProducts(adminContext, { slug: `returns-${suffix}`, name: `退貨分類${suffix}`, description: "退貨測試" }, [
      { name: lampName, priceTwd: 1000, stock: 8 },
    ]) as [number];
    const customer = createCustomer("退貨顧客", `returns-${suffix}@example.com`);
    const customerContext = await browser.newContext({ baseURL: BASE_URL, viewport });
    await customerContext.addCookies([memberSessionCookie({ token: customer.token })]);
    const admin = await adminContext.newPage();
    const page = await customerContext.newPage();
    page.on("dialog", (dialog) => void dialog.accept());
    admin.on("dialog", (dialog) => void dialog.accept());
    try {
      // 顧客下單、付款，管理員全部交運（一般配送，不需要預約時段）
      await page.goto(`/products/${lampId}`);
      const info = page.getByRole("region", { name: "商品資訊" });
      for (let count = 0; count < 3; count += 1) await info.getByRole("button", { name: "加入購物車", exact: true }).click();
      await expect(page.locator("#cart-count")).not.toHaveText("0");
      await page.goto("/checkout");
      await page.getByLabel("收件人姓名").fill("退貨王");
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

      // 顧客申請退貨 2 件（已出貨才有退貨入口）
      await page.goto(`/orders/${orderId}`);
      const form = page.getByRole("region", { name: "退貨申請" });
      await form.getByLabel(new RegExp(`${lampName}.*可退貨 3`)).fill("2");
      await form.getByLabel(/退貨原因/).fill("尺寸不合");
      await form.getByRole("button", { name: "申請退貨" }).click();
      await expect(page.getByRole("status").filter({ hasText: "已送出退貨申請" })).toBeVisible();
      const cases = page.getByRole("list", { name: "退貨申請紀錄" });
      await expect(cases).toContainText("待審核");
      await expect(cases).toContainText(`${lampName} × 2`);
      await expect(page.getByText("退貨處理中：2")).toBeVisible();
      await assertNoOverflowAndAxe(page, viewport.width);

      // 管理員待辦看得到；核准
      await admin.goto("/admin/returns");
      await expect(admin.getByRole("heading", { level: 1, name: "退貨處理" })).toBeVisible();
      const row = admin.getByRole("row").filter({ has: admin.getByRole("link", { name: new RegExp(`#${orderId}`) }) });
      await expect(row).toContainText(`${lampName} × 2`);
      await expect(row).toContainText("尺寸不合");
      await assertNoOverflowAndAxe(admin, viewport.width);
      await admin.goto(`/admin/orders/${orderId}`);
      await admin.getByLabel("審核備註（選填，會寄給顧客）").fill("請寄回");
      await admin.getByRole("button", { name: "核准退貨" }).click();
      await expect(admin.getByRole("status")).toContainText("已核准這案退貨申請");

      // 記錄收回：實際收到 2 件，進入不可售（待檢）
      await admin.getByLabel(new RegExp(`${lampName}.*申請 2`)).fill("2");
      await admin.getByRole("button", { name: "記錄收回" }).click();
      await expect(admin.getByRole("status")).toContainText("已記錄收回");
      const returns = admin.getByRole("list", { name: "退貨申請" });
      await expect(returns).toContainText("已收到，檢查中");

      // 檢查：1 件良品轉可售、1 件損壞品隔離；退款按實際收到的 2 件實付單價（不退運費，因為還有 1 件沒退）
      await admin.getByLabel("良品（轉可售）").fill("1");
      await admin.getByLabel("損壞品（隔離）").fill("1");
      await admin.getByRole("button", { name: "記錄檢查並退款" }).click();
      await expect(admin.getByRole("status")).toContainText("退款已成功退回");
      await expect(returns).toContainText("已檢查完成");
      await expect(returns).toContainText("應退商品款 NT$ 2,000、運費 NT$ 0");
      await expect(returns).toContainText("良品 1、損壞 1");
      await expect(admin.getByRole("region", { name: "退款資料表" })).toContainText("退貨檢查完成");
      await assertNoOverflowAndAxe(admin, viewport.width);

      // 庫存流水：收回入倉（在庫與不可售同增）與檢查合格（不可售轉可售）
      await admin.goto(`/admin/stock-movements?orderId=${orderId}`);
      await expect(admin.getByRole("row").filter({ hasText: "退貨收回入倉" })).toContainText("+2");
      await expect(admin.getByRole("row").filter({ hasText: "退貨檢查合格轉可售" })).toContainText("-1");

      // 損壞品報廢：在庫與不可售同減，原因進流水
      await admin.goto("/admin/returns");
      const scrap = admin.getByRole("region", { name: "不可售庫存" }).getByRole("row").filter({ hasText: lampName });
      await expect(scrap).toContainText("1");
      const ledgerUrl = await scrap.getByRole("link", { name: new RegExp(lampName) }).getAttribute("href");
      await scrap.getByLabel(`${lampName}的報廢數量`).fill("1");
      await scrap.getByLabel(`${lampName}的報廢原因`).fill("杯口缺角無法修復");
      await scrap.getByRole("button", { name: "報廢" }).click();
      await expect(admin.getByRole("status").filter({ hasText: "已報廢" })).toBeVisible();
      // 不可售庫存是全域清單（別的 spec 並行時可能還有其他商品）：只斷言這支檯燈已不在其中
      await expect(admin.getByRole("region", { name: "不可售庫存" }).getByRole("row").filter({ hasText: lampName })).toHaveCount(0);
      await admin.goto(`/admin/stock-movements?orderId=${orderId}`);
      await expect(admin.getByRole("row").filter({ hasText: "報廢" })).toHaveCount(0);
      await admin.goto(ledgerUrl!);
      await expect(admin.getByRole("row").filter({ hasText: "杯口缺角無法修復" })).toContainText("報廢");

      // 顧客：退貨處理結果、退款與通知
      await page.goto(`/orders/${orderId}`);
      await expect(page.getByRole("list", { name: "退貨申請紀錄" })).toContainText("已檢查完成");
      await expect(page.getByText("已退貨：2")).toBeVisible();
      await expect(page.getByRole("region", { name: "退款進度" })).toContainText("退貨已收到並檢查完成");
      await expect(page.getByRole("region", { name: "退款進度" })).toContainText("已退回原付款方式");
      await page.goto("/account/mailbox");
      await expect(page.getByRole("link", { name: new RegExp(`訂單 #${orderId} 的退貨申請已核准`) })).toBeVisible();
      await expect(page.getByRole("link", { name: new RegExp(`訂單 #${orderId} 的退貨已收到並檢查完成`) })).toBeVisible();
      await expect(page.getByRole("link", { name: new RegExp(`訂單 #${orderId} 已退款 NT\\$2000`) })).toBeVisible();

      // 顧客沒有管理員身分，看不到退貨處理頁
      const forbidden = await customerContext.request.get("/admin/returns", { maxRedirects: 0 });
      expect(forbidden.status()).not.toBe(200);
    } finally {
      await unlistProduct(adminContext.request, lampId);
      await adminContext.close();
      await customerContext.close();
    }
  });
}
