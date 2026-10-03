import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { adminAccessHeaders } from "../harness/admin-access";
import { unlistProduct, defaultVariantIds, seedListedProducts } from "../harness/admin-seed";
import { BASE_URL, ADMIN_EMAIL } from "../harness/constants";
import { createCustomer } from "../harness/customer-fixture";
import { memberSessionCookie } from "../harness/session-cookie";

async function assertLayout(page: Page, width: number) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth), "page overflow").toBeLessThanOrEqual(width);
  for (const region of await page.getByRole("region", { name: /資料表/ }).all()) {
    const size = await region.evaluate(element => ({ width: element.clientWidth, scroll: element.scrollWidth }));
    expect(size.scroll, `table region overflow: ${await region.getAttribute("aria-label")}`).toBeLessThanOrEqual(size.width);
  }
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
}

for (const viewport of [{ name: "手機", width: 375, height: 812 }, { name: "桌機", width: 1280, height: 900 }]) {
  test(`${viewport.name}：付款後在庫不變、交運才扣庫，流水記下調整與交運的來源、操作人與原因；顧客看不到流水`, async ({ browser }) => {
    test.setTimeout(180_000);
    const name = `流水燈具${viewport.width}`;
    const adminContext = await browser.newContext({ baseURL: BASE_URL, extraHTTPHeaders: adminAccessHeaders(), viewport });
    const [productId] = await seedListedProducts(adminContext, { slug: `ledger-${viewport.width}`, name: `流水分類${viewport.width}`, description: "庫存流水測試" }, [
      { name, priceTwd: 1000, stock: 5 },
    ]) as [number];
    const customer = createCustomer("流水顧客", `ledger-${viewport.width}@example.com`);
    const customerContext = await browser.newContext({ baseURL: BASE_URL, viewport });
    await customerContext.addCookies([memberSessionCookie({ token: customer.token })]);
    const admin = await adminContext.newPage();
    const page = await customerContext.newPage();
    try {
      // 商品列表分頁且依編號排序，其他 spec 的商品會把這件擠到後面頁：直接送出與表單相同的 POST
      const [variantId] = await defaultVariantIds(adminContext.request, [productId]);
      const adjusted = await adminContext.request.post("/admin", { form: { intent: "adjust-stock", variantId: String(variantId), delta: "-1", reason: "盤損測試" }, headers: { origin: BASE_URL }, maxRedirects: 0 });
      expect(adjusted.status()).toBe(303);

      await page.goto(`/products/${productId}`);
      await page.getByRole("region", { name: "商品資訊" }).getByRole("button", { name: "加入購物車", exact: true }).click();
      await expect(page.locator("#cart-count")).not.toHaveText("0");
      await page.goto("/checkout");
      await page.getByLabel("收件人姓名").fill("流水王");
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

      // 付款只轉為已付款保留：流水還沒有這張訂單的紀錄
      await admin.goto(`/admin/stock-movements?orderId=${orderId}`);
      await expect(admin.getByText("沒有符合的庫存流水。")).toBeVisible();

      admin.on("dialog", (dialog) => void dialog.accept());
      await admin.goto(`/admin/orders/${orderId}`);
      await admin.getByRole("button", { name: "確認交運這一批" }).click();
      await expect(admin.getByRole("status")).toHaveText("已記錄這一批出貨。");

      await admin.goto(`/admin/stock-movements?orderId=${orderId}`);
      const dispatchRow = admin.getByRole("row").filter({ hasText: "交運扣庫" });
      await expect(dispatchRow).toContainText(name);
      await expect(dispatchRow).toContainText("-1");
      await expect(dispatchRow).toContainText(ADMIN_EMAIL);
      await expect(dispatchRow.getByRole("link", { name: `#${orderId}` })).toBeVisible();
      await assertLayout(admin, viewport.width);

      // 該商品的流水：新的在前，交運、盤損調整、補貨，調整後在庫 3、4、5
      await dispatchRow.getByRole("link", { name }).click();
      const rows = admin.getByRole("region", { name: "庫存流水資料表" }).locator("tbody tr");
      await expect(rows).toHaveCount(3);
      await expect(rows.nth(0)).toContainText("交運扣庫");
      await expect(rows.nth(0).locator("td[data-label='調整後在庫']")).toHaveText("3");
      await expect(rows.nth(1)).toContainText("盤損測試");
      await expect(rows.nth(1).locator("td[data-label='調整後在庫']")).toHaveText("4");
      await expect(rows.nth(2)).toContainText("E2E 補貨");
      await expect(rows.nth(2).locator("td[data-label='調整後在庫']")).toHaveText("5");
      await assertLayout(admin, viewport.width);

      // 沒有經過 Access 的顧客進不了流水頁
      expect((await customerContext.request.get("/admin/stock-movements")).status()).toBe(403);
    } finally {
      await unlistProduct(adminContext.request, productId);
      await adminContext.close();
      await customerContext.close();
    }
  });
}
