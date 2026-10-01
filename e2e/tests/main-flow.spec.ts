import AxeBuilder from "@axe-core/playwright";
import { expect, test as base, type Page } from "@playwright/test";
import { adminAccessHeaders } from "../harness/admin-access";
import { BASE_URL, GATEWAY_API_KEY, GATEWAY_URL, MEMBER } from "../harness/constants";
import { memberSessionCookie } from "../harness/session-cookie";

const PRODUCT = { name: "E2E 測試商品", description: "E2E 流程用的商品", priceTwd: "1200" };
const TRACKING_NUMBER = "E2E-TRACK-0001";

const test = base.extend<{ admin: Page; gatewayConsole: Page }>({
  // 管理員 context 帶 Access JWT（與 Cloudflare Access 相同的 header），只會連到 Web；
  // 出貨表單有 confirm()，直接接受。fixture 結束時 context 一定會關閉
  admin: async ({ browser }, use) => {
    const context = await browser.newContext({ baseURL: BASE_URL, extraHTTPHeaders: adminAccessHeaders() });
    const page = await context.newPage();
    page.on("dialog", (dialog) => void dialog.accept());
    await use(page);
    await context.close();
  },
  // 閘道主控頁用 HTTP Basic（帳號任意，密碼為 GATEWAY_API_KEY）
  gatewayConsole: async ({ browser }, use) => {
    const context = await browser.newContext({ httpCredentials: { username: "e2e", password: GATEWAY_API_KEY } });
    await use(await context.newPage());
    await context.close();
  },
});

test("主流程：管理員上架補貨 → 顧客購物車與結帳 → 閘道付款成功（真實 webhook 與導回）→ 管理員出貨 → 顧客看到已出貨", async ({
  admin,
  gatewayConsole,
  page,
}, testInfo) => {
  // 1. 管理員上架商品並補貨
  await admin.goto("/admin");
  await admin.getByLabel("名稱", { exact: true }).fill(PRODUCT.name);
  await admin.getByLabel("說明", { exact: true }).fill(PRODUCT.description);
  await admin.getByLabel("單價（新台幣整數元）").fill(PRODUCT.priceTwd);
  await admin.getByRole("button", { name: "新增商品" }).click();
  await expect(admin.getByRole("status")).toHaveText("已新增商品。");

  const productRow = admin.getByRole("row", { name: new RegExp(PRODUCT.name) });
  await productRow.getByLabel(`${PRODUCT.name}的庫存增減量`).fill("+5");
  await productRow.getByRole("button", { name: "調整庫存" }).click();
  await expect(admin.getByRole("status")).toHaveText("已調整庫存。");
  await expect(admin.getByRole("row", { name: new RegExp(PRODUCT.name) })).toContainText("上架中");

  // 2. 顧客以直接寫入 D1 的 session 登入（ADR 0013）
  await page.context().addCookies([memberSessionCookie()]);

  // 3. 加入購物車 → 購物車頁 → 結帳 → 訂單頁待付款
  await page.goto("/");
  const productItem = page.getByRole("listitem").filter({ hasText: PRODUCT.name });
  await productItem.getByRole("button", { name: "加入購物車" }).click();
  await expect(productItem.getByRole("status")).not.toBeEmpty();

  await page.goto("/cart");
  await expect(page.getByRole("row", { name: new RegExp(PRODUCT.name) })).toBeVisible();
  await expect(page.getByText(/總金額：NT\$ 1,200/)).toBeVisible();
  await page.getByRole("link", { name: "前往結帳" }).click();

  await expect(page).toHaveURL(/\/checkout$/);
  await page.getByLabel("收件人姓名").fill("E2E 收件人");
  await page.getByLabel("收件人電話").fill("0912345678");
  await page.getByLabel("收件地址").fill("台北市中正區（E2E 示意地址）");
  await page.getByRole("button", { name: "送出訂單" }).click();

  await expect(page).toHaveURL(/\/orders\/\d+\?placed=1$/);
  const orderPath = new URL(page.url()).pathname;
  const orderId = orderPath.split("/").pop()!;
  await expect(page.getByText("訂單狀態：待付款")).toBeVisible();

  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  // 4. 前往付款 → 模擬閘道付款頁 → 成功＋立即回呼 → 導回訂單頁已付款
  await page.getByRole("button", { name: "前往付款" }).click();
  await expect(page).toHaveURL(new RegExp(`^${GATEWAY_URL}/pay/`));
  const paymentId = new URL(page.url()).pathname.split("/").pop()!;
  await page.getByRole("radio", { name: "成功" }).check();
  await page.getByRole("radio", { name: "立即回呼" }).check();

  // 閘道先同步送出簽章 webhook，再 303 導回 /orders/:id/payment-return（App 向閘道查詢）→ 訂單頁
  const paymentReturn = page.waitForResponse(
    (response) => response.url() === `${BASE_URL}${orderPath}/payment-return?paymentId=${paymentId}` && response.status() === 303,
  );
  await page.getByRole("button", { name: "送出" }).click();
  await paymentReturn;

  await expect(page).toHaveURL(`${BASE_URL}${orderPath}`);
  await expect(page.getByText("訂單狀態：已付款")).toBeVisible();
  await expect(page.getByText("已收到付款，訂單已付款。")).toBeVisible();

  // webhook 確實被 Web 驗簽並回 2xx：閘道主控頁「這一筆付款」的投遞紀錄是 HTTP 200（驗簽失敗會是 401）
  await gatewayConsole.goto(`${GATEWAY_URL}/console`);
  const paymentSection = gatewayConsole.locator("section").filter({ has: gatewayConsole.locator("code", { hasText: paymentId }) });
  await expect(paymentSection).toContainText("payment.succeeded");
  await expect(paymentSection).toContainText("HTTP 200");

  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  // 5. 管理員在 /admin/orders 看到已付款 → 明細 → 出貨
  await admin.goto("/admin/orders");
  const orderRow = admin.getByRole("row", { name: new RegExp(`#${orderId}\\b`) });
  await expect(orderRow).toContainText(MEMBER.email);
  await expect(orderRow).toContainText("已付款");
  await orderRow.getByRole("link", { name: `#${orderId}` }).click();

  await expect(admin).toHaveURL(`${BASE_URL}/admin/orders/${orderId}`);
  await admin.getByLabel("物流單號（可留空）").fill(TRACKING_NUMBER);
  await admin.getByRole("button", { name: "標為已出貨" }).click();
  await expect(admin.getByRole("status")).toHaveText("已標為已出貨。");
  await expect(admin.getByText(`物流單號：${TRACKING_NUMBER}`)).toBeVisible();

  // 6. 顧客回訂單頁看到已出貨與物流單號
  await page.goto(orderPath);
  await expect(page.getByText("訂單狀態：已出貨")).toBeVisible();
  await expect(page.getByText(`物流單號：${TRACKING_NUMBER}`)).toBeVisible();
  for (const width of [320, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await testInfo.attach(`order-${width}`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
  }
});
