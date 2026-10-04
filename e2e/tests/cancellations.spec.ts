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

/** 既有的訂單頁（返回連結、交運按鈕等）有尺寸不足的控制項（不在這張票範圍）：只檢查無水平捲動與 axe 零違規。 */
async function assertNoOverflowAndAxe(page: Page, width: number) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth), "page overflow").toBeLessThanOrEqual(width);
  expect((await analyzeWhenSettled(page)).violations).toEqual([]);
}

for (const viewport of [{ name: "手機", width: 375, height: 812 }, { name: "桌機", width: 1280, height: 900 }]) {
  test(`${viewport.name}：顧客申請部分取消，申請期間暫停交運；管理員核准後釋放並逐案退款、另一案拒絕後解凍，雙方查得到各案、退款與通知`, async ({ browser }) => {
    test.setTimeout(300_000);
    const suffix = `${viewport.width}`;
    const lampName = `取消檯燈${suffix}`;
    const adminContext = await browser.newContext({ baseURL: BASE_URL, extraHTTPHeaders: adminAccessHeaders(), viewport });
    const [lampId] = await seedListedProducts(adminContext, { slug: `cancellations-${suffix}`, name: `取消分類${suffix}`, description: "部分取消測試" }, [
      { name: lampName, priceTwd: 1000, stock: 8 },
    ]) as [number];
    const customer = createCustomer("取消顧客", `cancellations-${suffix}@example.com`);
    const customerContext = await browser.newContext({ baseURL: BASE_URL, viewport });
    await customerContext.addCookies([memberSessionCookie({ token: customer.token })]);
    const admin = await adminContext.newPage();
    const page = await customerContext.newPage();
    page.on("dialog", (dialog) => void dialog.accept());
    admin.on("dialog", (dialog) => void dialog.accept());
    try {
      await page.goto(`/products/${lampId}`);
      const info = page.getByRole("region", { name: "商品資訊" });
      for (let count = 0; count < 3; count += 1) {
        await info.getByRole("button", { name: "加入購物車", exact: true }).click();
        await expect(page.locator("#cart-count")).toHaveText(String(count + 1));
      }
      await page.goto("/checkout");
      await page.getByLabel("收件人姓名").fill("取消王");
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

      // 顧客申請取消 2 件：申請期間暫停出貨
      const form = page.getByRole("region", { name: "取消申請" });
      await form.getByLabel(new RegExp(`${lampName}.*可取消 3`)).fill("2");
      await form.getByLabel("申請原因（選填）").fill("買多了");
      await form.getByRole("button", { name: "申請取消" }).click();
      await expect(page.getByRole("status").filter({ hasText: "已送出取消申請" })).toBeVisible();
      const cases = page.getByRole("list", { name: "取消申請紀錄" });
      await expect(cases).toContainText("待審核");
      await expect(cases).toContainText(`${lampName} × 2`);
      await expect(page.getByText("取消審核中：2（暫停出貨）")).toBeVisible();
      await assertNoOverflowAndAxe(page, viewport.width);

      // 管理員待辦看得到；交運表單只剩未被占用的 1 件
      await admin.goto("/admin/cancellations");
      await expectNothingOmitted(admin);
      await expect(admin.getByRole("heading", { level: 1, name: "取消審核" })).toBeVisible();
      const row = admin.getByRole("row").filter({ has: admin.getByRole("link", { name: new RegExp(`#${orderId}`) }) });
      await expect(row).toContainText(`${lampName} × 2`);
      await expect(row).toContainText("買多了");
      await assertLayout(admin, viewport.width);
      await admin.goto(`/admin/orders/${orderId}`);
      await expect(admin.getByLabel(new RegExp(`${lampName}.*未交運 1`))).toBeVisible();

      // 核准：釋放並退商品款（2 × 1000），運費不退（同類沒有全數取消），退款成功
      await admin.getByLabel("審核備註（選填，會寄給顧客）").fill("已確認");
      await admin.getByRole("button", { name: "核准取消並退款" }).click();
      await expect(admin.getByRole("status")).toContainText("退款已成功退回");
      const decided = admin.getByRole("list", { name: "取消申請" });
      await expect(decided).toContainText("已核准");
      await expect(decided).toContainText("應退商品款 NT$ 2,000、運費 NT$ 0");
      const refundTable = admin.getByRole("region", { name: "退款資料表" });
      await expect(refundTable).toContainText("取消申請核准");
      await expect(refundTable).toContainText("已退回");
      await expect(admin.getByLabel(new RegExp(`${lampName}.*未交運 1`))).toBeVisible();
      await assertNoOverflowAndAxe(admin, viewport.width);

      // 顧客：核准的案件、逐筆退款與通知
      await page.goto(`/orders/${orderId}`);
      await expect(page.getByRole("list", { name: "取消申請紀錄" })).toContainText("已核准");
      await expect(page.getByText("已取消：2")).toBeVisible();
      await expect(page.getByRole("region", { name: "退款進度" })).toContainText("取消申請已核准");
      await expect(page.getByRole("region", { name: "退款進度" })).toContainText("已退回原付款方式");

      // 第二案（剩下的 1 件）被拒絕後解凍：數量恢復可交運，沒有新的退款
      const second = page.getByRole("region", { name: "取消申請" });
      await second.getByLabel(new RegExp(`${lampName}.*可取消 1`)).fill("1");
      await second.getByRole("button", { name: "申請取消" }).click();
      await expect(page.getByRole("list", { name: "取消申請紀錄" })).toContainText("待審核");
      await admin.goto(`/admin/orders/${orderId}`);
      await expect(admin.getByLabel(new RegExp(`${lampName}.*未交運`))).toHaveCount(0);
      await admin.getByLabel("審核備註（選填，會寄給顧客）").fill("已在備貨");
      await admin.getByRole("button", { name: "拒絕", exact: true }).click();
      await expect(admin.getByRole("status")).toContainText("已拒絕這案取消申請");
      await expect(admin.getByLabel(new RegExp(`${lampName}.*未交運 1`))).toBeVisible();
      await page.goto(`/orders/${orderId}`);
      await expect(page.getByRole("list", { name: "取消申請紀錄" })).toContainText("未獲核准");
      await expect(page.getByRole("list", { name: "取消申請紀錄" })).toContainText("已在備貨");
      await expect(page.getByRole("region", { name: "退款進度" }).getByRole("row")).toHaveCount(2);

      // 顧客收到審核與退款通知
      await page.goto("/account/mailbox");
      await expect(page.getByRole("link", { name: new RegExp(`訂單 #${orderId} 的取消申請已核准`) })).toBeVisible();
      await expect(page.getByRole("link", { name: new RegExp(`訂單 #${orderId} 的取消申請未獲核准`) })).toBeVisible();
      await expect(page.getByRole("link", { name: new RegExp(`訂單 #${orderId} 已退款 NT\\$2000`) })).toBeVisible();
      await assertLayout(page, viewport.width);

      // 顧客沒有管理員身分，看不到審核頁
      const forbidden = await customerContext.request.get("/admin/cancellations", { maxRedirects: 0 });
      expect(forbidden.status()).not.toBe(200);
    } finally {
      await unlistProduct(adminContext.request, lampId);
      await adminContext.close();
      await customerContext.close();
    }
  });
}
