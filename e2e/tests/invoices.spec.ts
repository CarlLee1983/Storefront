import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { adminAccessHeaders } from "../harness/admin-access";
import { seedListedProducts } from "../harness/admin-seed";
import { BASE_URL } from "../harness/constants";
import { createCustomer, writeFixture } from "../harness/customer-fixture";
import { memberSessionCookie } from "../harness/session-cookie";

/** 無水平捲動、主要區域的操作元件至少 44px、無 axe 違規。 */
async function assertLayout(page: Page, width: number) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth), "page overflow").toBeLessThanOrEqual(width);
  for (const control of await page.locator("main :is(a, button, input):not([role=status] a)").all()) {
    if (!(await control.isVisible())) continue;
    const box = await control.boundingBox();
    if (box) expect(box.height, `${await control.textContent()} 高度`).toBeGreaterThanOrEqual(44);
  }
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
}

/** 既有的訂單頁（顧客的返回連結、後台的交運按鈕）有尺寸不足的控制項（不在這張票範圍）：只檢查無水平捲動與 axe 零違規。 */
async function assertNoOverflowAndAxe(page: Page, width: number) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth), "page overflow").toBeLessThanOrEqual(width);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
}

/** 顧客下單並以模擬閘道付款成功（立即回呼），回傳訂單編號。 */
async function placePaidOrder(page: Page, productId: number, name: string): Promise<string> {
  await page.goto(`/products/${productId}`);
  await page.getByRole("region", { name: "商品資訊" }).getByRole("button", { name: "加入購物車", exact: true }).click();
  await expect(page.locator("#cart-count")).not.toHaveText("0");
  await page.goto("/checkout");
  await page.getByLabel("收件人姓名").fill(name);
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
  return orderId;
}

/** 把這張訂單的發票安排成「開立失敗」（前置資料）：刪掉已寄的憑證信，狀態回到明確失敗並留一筆失敗嘗試；發票服務那邊已有同一個冪等鍵，補辦會回同一張。 */
function seedFailedInvoice(orderId: string): void {
  const now = Date.now();
  writeFixture(
    `DELETE FROM mail_deliveries WHERE message_id IN (SELECT m.id FROM mail_messages m JOIN invoices i ON m.event_key = 'invoice:' || i.id WHERE i.order_id = ${orderId}); ` +
      `DELETE FROM mail_messages WHERE event_key IN (SELECT 'invoice:' || id FROM invoices WHERE order_id = ${orderId}); ` +
      `UPDATE invoices SET status = 'failed', invoice_number = NULL, issued_at = NULL WHERE order_id = ${orderId}; ` +
      `INSERT INTO invoice_attempts (invoice_id, at, actor, action, outcome, code) SELECT id, ${now}, 'system', 'send', 'failed', 'invoice_failed' FROM invoices WHERE order_id = ${orderId};`,
  );
}

/** 在這張訂單的成功付款上安排一筆已成功的退款與它的待折讓義務（前置資料，尚未送出折讓）。 */
function seedSucceededRefund(orderId: string): void {
  const now = Date.now();
  writeFixture(
    `INSERT INTO refunds (order_id, payment_id, reason, gateway_refund_id, amount_twd, goods_twd, shipping_twd, status, created_at, settled_at) ` +
      `SELECT order_id, id, 'duplicate_success', 'rf_e2e_inv_' || order_id, 100, 100, 0, 'succeeded', ${now}, ${now} FROM payments WHERE order_id = ${orderId} AND status = 'succeeded'; ` +
      `INSERT INTO allowance_obligations (refund_id, payment_id, order_id, amount_twd, created_at, gateway_allowance_key, status) SELECT id, payment_id, order_id, amount_twd, ${now}, 'alw_e2e_' || id, 'pending' FROM refunds WHERE order_id = ${orderId};`,
  );
}

for (const viewport of [{ name: "手機", width: 375, height: 812 }, { name: "桌機", width: 1280, height: 900 }]) {
  test(`${viewport.name}：付款成功自動開立模擬發票並通知；開立失敗不影響付款、管理員補辦；已退款標示憑證待補、只顯示原額；管理員重寄憑證；管理員補辦折讓後顧客看到累計折讓與餘額並收到通知、可重寄通知；顧客不能看待辦頁`, async ({ browser }) => {
    test.setTimeout(300_000);
    const suffix = `${viewport.width}`;
    const adminContext = await browser.newContext({ baseURL: BASE_URL, extraHTTPHeaders: adminAccessHeaders(), viewport });
    const [productId] = await seedListedProducts(adminContext, { slug: `invoices-${suffix}`, name: `發票分類${suffix}`, description: "發票測試" }, [
      { name: `發票檯燈${suffix}`, priceTwd: 800, stock: 6 },
    ]) as [number];
    const customer = createCustomer("發票顧客", `invoices-${suffix}@example.com`);
    const customerContext = await browser.newContext({ baseURL: BASE_URL, viewport });
    await customerContext.addCookies([memberSessionCookie({ token: customer.token })]);
    const admin = await adminContext.newPage();
    const page = await customerContext.newPage();
    try {
      const issuedOrder = await placePaidOrder(page, productId, "發票王");
      const failedOrder = await placePaidOrder(page, productId, "發票王");

      // 付款成功後自動開立：顧客在訂單頁看到發票號碼與原額（NT$ 900 = 商品 800 + 運費 100），並收到通知
      await page.goto(`/orders/${issuedOrder}`);
      const invoices = page.locator("#invoices");
      await expect(invoices).toContainText("已開立");
      await expect(invoices).toContainText(/SM-[0-9A-F]{8}/);
      await expect(invoices).toContainText("NT$ 900");
      await expect(invoices).not.toContainText("憑證待補");
      await assertNoOverflowAndAxe(page, viewport.width);
      await page.goto("/account/mailbox");
      await expect(page.getByRole("link", { name: new RegExp(`訂單 #${issuedOrder} 的模擬發票已開立`) })).toBeVisible();

      // 開立失敗：付款與訂單照常已付款；顧客只看到「開立中」，不揭露內部失敗
      seedFailedInvoice(failedOrder);
      await page.goto(`/orders/${failedOrder}`);
      await expect(page.getByText("訂單狀態：已付款")).toBeVisible();
      await expect(page.locator("#invoices")).toContainText("開立中");
      await expect(page.locator("#invoices")).not.toContainText(/失敗|不明/);

      // 管理員的發票待辦如實列出明確失敗，補辦後同一張發票開立、顧客收到通知
      await admin.goto("/admin/invoices");
      await expect(admin.getByRole("heading", { level: 1, name: "發票待辦" })).toBeVisible();
      const failedRow = admin.getByRole("row").filter({ has: admin.getByRole("link", { name: `#${failedOrder}`, exact: true }) });
      await expect(failedRow).toContainText("明確失敗");
      await expect(failedRow).toContainText("開立發票：明確失敗（invoice_failed）");
      await assertLayout(admin, viewport.width);
      await failedRow.getByRole("button", { name: /補辦發票/ }).click();
      await expect(admin.getByRole("status")).toContainText("發票已開立");
      await expect(admin.getByRole("link", { name: `#${failedOrder}`, exact: true })).toHaveCount(0);
      await page.goto(`/orders/${failedOrder}`);
      await expect(page.locator("#invoices")).toContainText("已開立");
      await expect(page.locator("#invoices")).toContainText(/SM-[0-9A-F]{8}/);
      await page.goto("/account/mailbox");
      await expect(page.getByRole("link", { name: new RegExp(`訂單 #${failedOrder} 的模擬發票已開立`) })).toBeVisible();
      await assertLayout(page, viewport.width);

      // 已成功退款：憑證待補，原票仍只顯示原額（NT$ 900），不宣稱已結清或剩餘金額
      seedSucceededRefund(issuedOrder);
      await page.goto(`/orders/${issuedOrder}`);
      await expect(page.locator("#invoices")).toContainText("憑證待補");
      await expect(page.locator("#invoices")).toContainText("NT$ 900");
      await expect(page.locator("#invoices")).not.toContainText(/已結清|剩餘/);
      await assertNoOverflowAndAxe(page, viewport.width);
      await admin.goto("/admin/invoices");
      await expect(admin.getByRole("region", { name: "待折讓的退款" })).toContainText(`#${issuedOrder}`);
      await assertLayout(admin, viewport.width);

      // 管理員在訂單頁看到待折讓並重寄憑證；信件歷史保留（顧客信箱仍只有一封，內容不變）
      await admin.goto(`/admin/orders/${issuedOrder}`);
      const invoiceTable = admin.getByRole("region", { name: "發票資料表" });
      await expect(invoiceTable).toContainText("已開立");
      await expect(invoiceTable).toContainText("憑證待補：NT$ 100");
      await invoiceTable.getByRole("button", { name: /重寄憑證發票/ }).click();
      await expect(admin.getByRole("status")).toContainText("憑證已重寄");
      await assertNoOverflowAndAxe(admin, viewport.width);
      await page.goto("/account/mailbox");
      await expect(page.getByRole("link", { name: new RegExp(`訂單 #${issuedOrder} 的模擬發票已開立`) })).toHaveCount(1);

      // 管理員在待辦補辦折讓：折讓完成後顧客看到累計折讓與餘額（NT$ 900 - 100 = 800），不再憑證待補，並收到折讓通知
      await admin.goto("/admin/invoices");
      const allowanceRow = admin.getByRole("region", { name: "待折讓的退款" }).getByRole("row").filter({ has: admin.getByRole("link", { name: `#${issuedOrder}`, exact: true }) });
      await expect(allowanceRow).toContainText("待折讓");
      await assertLayout(admin, viewport.width);
      await allowanceRow.getByRole("button", { name: /補辦折讓/ }).click();
      await expect(admin.getByRole("status")).toContainText("折讓已完成");
      await expect(admin.getByRole("link", { name: `#${issuedOrder}`, exact: true })).toHaveCount(0);
      await page.goto(`/orders/${issuedOrder}`);
      await expect(page.locator("#invoices")).toContainText("已折讓 1 筆，累計 NT$ 100");
      await expect(page.locator("#invoices")).toContainText("折讓後餘額 NT$ 800");
      await expect(page.locator("#invoices")).not.toContainText("憑證待補");
      await assertNoOverflowAndAxe(page, viewport.width);
      await page.goto("/account/mailbox");
      await expect(page.getByRole("link", { name: new RegExp(`訂單 #${issuedOrder} 的退款已折讓`) })).toHaveCount(1);
      await admin.goto(`/admin/orders/${issuedOrder}`);
      await expect(invoiceTable).toContainText("已折讓 NT$ 100");
      await invoiceTable.getByRole("button", { name: /重寄折讓通知/ }).click();
      await expect(admin.getByRole("status")).toContainText("折讓通知已重寄");
      await assertNoOverflowAndAxe(admin, viewport.width);

      // 顧客沒有管理員身分，看不到發票待辦
      const forbidden = await customerContext.request.get("/admin/invoices", { maxRedirects: 0 });
      expect(forbidden.status()).not.toBe(200);
    } finally {
      await adminContext.request.post("/admin", { form: { intent: "unlist", id: String(productId) }, headers: { origin: BASE_URL }, maxRedirects: 0 });
      await adminContext.close();
      await customerContext.close();
    }
  });
}
