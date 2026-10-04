import { expect, test, type Page } from "@playwright/test";
import { adminAccessHeaders } from "../harness/admin-access";
import { gotoOrderList } from "../harness/admin-list";
import { seedListedProducts } from "../harness/admin-seed";
import { BASE_URL } from "../harness/constants";
import { createCustomer, writeFixture } from "../harness/customer-fixture";
import { memberSessionCookie } from "../harness/session-cookie";
import { analyzeWhenSettled } from "../harness/axe";

/** 既有的訂單頁有尺寸不足的控制項（不在這張票範圍）：只檢查無水平捲動與 axe 零違規。 */
async function assertNoOverflowAndAxe(page: Page, width: number) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth), "page overflow").toBeLessThanOrEqual(width);
  expect((await analyzeWhenSettled(page)).violations).toEqual([]);
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
  test(`${viewport.name}：訂單頁同時呈現發票待補與折讓待補，時間線依序列出下單與付款；顧客看不到操作人與待辦，管理員有待辦入口可跳到可操作區塊`, async ({ browser }) => {
    test.setTimeout(300_000);
    const suffix = `${viewport.width}`;
    const adminContext = await browser.newContext({ baseURL: BASE_URL, extraHTTPHeaders: adminAccessHeaders(), viewport });
    const [productId] = await seedListedProducts(adminContext, { slug: `timeline-${suffix}`, name: `時間線分類${suffix}`, description: "時間線測試" }, [
      { name: `時間線檯燈${suffix}`, priceTwd: 800, stock: 6 },
    ]) as [number];
    const customer = createCustomer("時間線顧客", `timeline-${suffix}@example.com`);
    const customerContext = await browser.newContext({ baseURL: BASE_URL, viewport });
    await customerContext.addCookies([memberSessionCookie({ token: customer.token })]);
    const admin = await adminContext.newPage();
    const page = await customerContext.newPage();
    try {
      const orderId = await placePaidOrder(page, productId, "時間線王");
      seedFailedInvoice(orderId);
      seedSucceededRefund(orderId);

      await page.goto(`/orders/${orderId}`);
      const timeline = page.getByRole("region", { name: "進度與時間線" });
      await expect(timeline.getByRole("list", { name: "目前同時成立的進度" })).toContainText("發票開立中");
      await expect(timeline.getByRole("list", { name: "目前同時成立的進度" })).toContainText("發票折讓待補");
      const events = timeline.getByRole("list", { name: "事件時間線（台北時間）" }).getByRole("listitem");
      await expect(events.first()).toContainText("訂單成立");
      await expect(events.nth(1)).toContainText("付款成功");
      await expect(timeline).toContainText("退款已退回 NT$ 100");
      await expect(timeline).not.toContainText("admin@");
      await expect(timeline.getByRole("link")).toHaveCount(0);
      await assertNoOverflowAndAxe(page, viewport.width);

      await gotoOrderList(admin, orderId);
      const listUrl = admin.url();
      const list = admin.getByRole("region", { name: "管理資料表" });
      await expect(admin.getByLabel("訂單編號")).toHaveValue(orderId);
      await expect(list.getByRole("link", { name: `#${orderId}` })).toHaveCount(1);
      await list.getByRole("link", { name: `#${orderId}` }).click();
      const adminTimeline = admin.getByRole("region", { name: "進度與時間線" });
      await expect(adminTimeline.getByRole("list", { name: "目前同時成立的進度" })).toContainText("發票待補");
      await adminTimeline.getByRole("link", { name: /發票待補辦/ }).click();
      expect(new URL(admin.url()).searchParams.get("returnTo")).toBe(`/admin/orders?orderId=${orderId}`);
      await expect(admin).toHaveURL(new RegExp(`/admin/orders/${orderId}\\?returnTo=.*#invoices$`));
      await expect(admin.locator("#invoices")).toBeVisible();
      await assertNoOverflowAndAxe(admin, viewport.width);
      await admin.getByRole("navigation", { name: "麵包屑" }).getByRole("link", { name: "訂單管理" }).click();
      await expect(admin).toHaveURL(listUrl);
      await expect(admin.getByLabel("訂單編號")).toHaveValue(orderId);
      await expect(admin.getByRole("region", { name: "管理資料表" }).getByRole("link", { name: `#${orderId}` })).toHaveCount(1);

      await admin.goto(`/admin/orders/${orderId}`);
      await admin.getByRole("region", { name: "進度與時間線" }).getByRole("link", { name: /發票待補辦/ }).click();
      await expect(admin).toHaveURL(`${BASE_URL}/admin/orders/${orderId}#invoices`);
    } finally {
      await adminContext.close();
      await customerContext.close();
    }
  });
}
