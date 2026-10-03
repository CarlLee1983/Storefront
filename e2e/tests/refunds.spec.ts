import { expect, test, type Page } from "@playwright/test";
import { adminAccessHeaders } from "../harness/admin-access";
import { unlistProduct, seedListedProducts } from "../harness/admin-seed";
import { BASE_URL } from "../harness/constants";
import { createCustomer, writeFixture } from "../harness/customer-fixture";
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

/** 既有的訂單頁（顧客的返回連結、後台的交運按鈕）有尺寸不足的控制項（不在這張票範圍）：只檢查無水平捲動與 axe 零違規。 */
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

/** 在這張訂單的成功付款上安排一筆整筆退款（前置資料）：`failed` 是閘道明確失敗過，`unknown` 是上次逾時結果不明。 */
function seedRefund(orderId: string, status: "failed" | "unknown"): void {
  const outcome = status === "failed" ? "failed" : "unknown";
  const code = status === "failed" ? "refund_failed" : "unreachable";
  const now = Date.now();
  writeFixture(
    `INSERT INTO refunds (order_id, payment_id, reason, gateway_refund_id, amount_twd, goods_twd, shipping_twd, status, created_at) ` +
      `SELECT order_id, id, 'duplicate_success', 'rf_e2e_' || order_id, amount_twd, amount_twd, 0, '${status}', ${now} FROM payments WHERE order_id = ${orderId} AND status = 'succeeded'; ` +
      `INSERT INTO refund_attempts (refund_id, at, actor, action, outcome, code) SELECT id, ${now}, 'system', 'send', '${outcome}', '${code}' FROM refunds WHERE order_id = ${orderId};`,
  );
}

for (const viewport of [{ name: "手機", width: 375, height: 812 }, { name: "桌機", width: 1280, height: 900 }]) {
  test(`${viewport.name}：管理員在退款待辦重試明確失敗、查證結果不明的退款，顧客逐筆看到進度與通知；顧客不能看待辦頁`, async ({ browser }) => {
    test.setTimeout(300_000);
    const suffix = `${viewport.width}`;
    const adminContext = await browser.newContext({ baseURL: BASE_URL, extraHTTPHeaders: adminAccessHeaders(), viewport });
    const [productId] = await seedListedProducts(adminContext, { slug: `refunds-${suffix}`, name: `退款分類${suffix}`, description: "退款測試" }, [
      { name: `退款檯燈${suffix}`, priceTwd: 800, stock: 6 },
    ]) as [number];
    const customer = createCustomer("退款顧客", `refunds-${suffix}@example.com`);
    const customerContext = await browser.newContext({ baseURL: BASE_URL, viewport });
    await customerContext.addCookies([memberSessionCookie({ token: customer.token })]);
    const admin = await adminContext.newPage();
    const page = await customerContext.newPage();
    try {
      const failedOrder = await placePaidOrder(page, productId, "退款王");
      const unknownOrder = await placePaidOrder(page, productId, "退款王");
      seedRefund(failedOrder, "failed");
      seedRefund(unknownOrder, "unknown");

      // 顧客在訂單頁只看到「處理中」，不揭露內部的失敗與不明
      await page.goto(`/orders/${failedOrder}`);
      const customerRefunds = page.getByRole("region", { name: "退款進度" });
      await expect(customerRefunds).toContainText("退款處理中");
      await expect(customerRefunds).not.toContainText(/失敗|不明/);
      await assertNoOverflowAndAxe(page, viewport.width);

      // 管理員的待辦如實區分兩種狀態，並給出各自的操作
      await admin.goto("/admin/refunds");
      await expectNothingOmitted(admin);
      await expect(admin.getByRole("heading", { level: 1, name: "退款待辦" })).toBeVisible();
      const failedRow = admin.getByRole("row").filter({ has: admin.getByRole("link", { name: `#${failedOrder}`, exact: true }) });
      const unknownRow = admin.getByRole("row").filter({ has: admin.getByRole("link", { name: `#${unknownOrder}`, exact: true }) });
      await expect(failedRow).toContainText("明確失敗");
      await expect(unknownRow).toContainText("結果不明");
      await expect(unknownRow.getByRole("button", { name: /查證並重試退款/ })).toBeVisible();
      await assertLayout(admin, viewport.width);

      // 明確失敗：直接重送，沿用同一筆退款
      await failedRow.getByRole("button", { name: /重試退款/ }).click();
      await expect(admin.getByRole("status")).toContainText("退款已成功");
      await expect(admin.getByRole("row").filter({ has: admin.getByRole("link", { name: `#${failedOrder}`, exact: true }) })).toHaveCount(0);

      // 結果不明：先向閘道查證（閘道從未收過），再送出
      await admin.getByRole("row").filter({ has: admin.getByRole("link", { name: `#${unknownOrder}`, exact: true }) }).getByRole("button", { name: /查證並重試退款/ }).click();
      await expect(admin.getByRole("status")).toContainText("退款已成功");
      await expect(admin.getByRole("link", { name: `#${unknownOrder}`, exact: true })).toHaveCount(0);
      await assertLayout(admin, viewport.width);

      // 訂單明細留下兩次嘗試（含查證）與操作者
      await admin.goto(`/admin/orders/${unknownOrder}`);
      const refundTable = admin.getByRole("region", { name: "退款資料表" });
      await expect(refundTable).toContainText("已退回");
      await expect(refundTable).toContainText("向閘道查證：閘道從未收過這筆退款");
      await expect(refundTable).toContainText("送出退款：成功");
      await assertNoOverflowAndAxe(admin, viewport.width);

      // 顧客的進度與通知一致
      await page.goto(`/orders/${failedOrder}`);
      await expect(page.getByRole("region", { name: "退款進度" })).toContainText("已退回原付款方式");
      await page.goto("/account/mailbox");
      await expect(page.getByRole("link", { name: new RegExp(`訂單 #${failedOrder} 已退款`) })).toBeVisible();
      await expect(page.getByRole("link", { name: new RegExp(`訂單 #${unknownOrder} 已退款`) })).toBeVisible();
      await assertLayout(page, viewport.width);

      // 顧客沒有管理員身分，看不到退款待辦
      const forbidden = await customerContext.request.get("/admin/refunds", { maxRedirects: 0 });
      expect(forbidden.status()).not.toBe(200);
    } finally {
      await unlistProduct(adminContext.request, productId);
      await adminContext.close();
      await customerContext.close();
    }
  });
}
