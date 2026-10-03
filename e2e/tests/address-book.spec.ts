import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { adminAccessHeaders } from "../harness/admin-access";
import { seedListedProducts } from "../harness/admin-seed";
import { BASE_URL } from "../harness/constants";
import { createCustomer } from "../harness/customer-fixture";
import { memberSessionCookie } from "../harness/session-cookie";
import { analyzeWhenSettled } from "../harness/axe";

const VIEWPORTS = [{ name: "手機", width: 375, height: 812 }, { name: "桌機", width: 1280, height: 900 }] as const;

/** 無水平捲動、主要區域的操作元件至少 44px、無 axe 違規。 */
async function assertAccessibleLayout(page: Page, width: number) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth), "page overflow").toBeLessThanOrEqual(width);
  for (const control of await page.locator("main :is(a, button, input, select)").all()) {
    if (!(await control.isVisible())) continue;
    const box = await control.boundingBox();
    if (!box) continue;
    expect(box.height, `${await control.textContent()} 高度`).toBeGreaterThanOrEqual(44);
  }
  expect((await analyzeWhenSettled(page)).violations).toEqual([]);
}

async function customerPage(browser: Browser, token: string, viewport: { width: number; height: number }): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: BASE_URL, viewport });
  await context.addCookies([memberSessionCookie({ token })]);
  return { context, page: await context.newPage() };
}

async function addAddress(page: Page, info: { name: string; phone: string; address: string }) {
  const form = page.getByRole("region", { name: "新增地址" });
  await form.getByLabel("收件人姓名").fill(info.name);
  await form.getByLabel("收件人電話").fill(info.phone);
  await form.getByLabel("收件地址").fill(info.address);
  await form.getByRole("button", { name: "新增地址" }).click();
}

const HOME = { name: "地址簿王", phone: "0912345678", address: "台北市中正區重慶南路一段 122 號" };
const OFFICE = { name: "地址簿王", phone: "02-1234-5678", address: "新北市板橋區文化路一段 1 號" };

test("未登入不能進入地址簿，會被導去登入", async ({ page }) => {
  await page.goto("/account/addresses");
  await expect(page).toHaveURL(/\/login/);
});

for (const viewport of VIEWPORTS) {
  test(`${viewport.name}：新增、修改、刪除地址並在結帳選用，改地址簿不改舊單；別人看不到我的地址`, async ({ browser }) => {
    test.setTimeout(120_000);
    const suffix = `${viewport.width}`;
    const productName = `地址簿商品${suffix}`;
    const adminContext = await browser.newContext({ baseURL: BASE_URL, extraHTTPHeaders: adminAccessHeaders() });
    let productId: number | undefined;
    try {
      [productId] = await seedListedProducts(adminContext, { slug: `address-${suffix}`, name: `收件分類${suffix}`, description: "地址簿測試" }, [{ name: productName, priceTwd: 700, stock: 3 }]);
    } finally { await adminContext.close(); }

    const customer = createCustomer("地址簿顧客", `address-${suffix}@example.com`);
    const other = createCustomer("另一位顧客", `other-${suffix}@example.com`);
    const { context, page } = await customerPage(browser, customer.token, viewport);
    const otherSide = await customerPage(browser, other.token, viewport);
    try {
      // 新增兩筆
      await page.goto("/account");
      await page.getByRole("main").getByRole("link", { name: "地址簿", exact: true }).click();
      await expect(page).toHaveURL(/\/account\/addresses$/);
      await expect(page.getByText("地址簿還是空的")).toBeVisible();
      await assertAccessibleLayout(page, viewport.width);
      await addAddress(page, HOME);
      await expect(page.getByRole("status")).toHaveText("已新增地址。");
      await addAddress(page, OFFICE);
      await expect(page.getByRole("status")).toHaveText("已新增地址。");
      await assertAccessibleLayout(page, viewport.width);
      await expect(page.locator("input[name=address]")).toHaveCount(3); // 兩筆 + 新增表單

      // 驗證失敗留在本頁並保留輸入
      await page.getByRole("region", { name: "新增地址" }).getByLabel("收件人姓名").fill("只有姓名");
      await page.getByRole("region", { name: "新增地址" }).getByLabel("收件人電話").fill("0911111111");
      await page.getByRole("region", { name: "新增地址" }).getByLabel("收件地址").fill("x".repeat(301));
      await page.getByRole("region", { name: "新增地址" }).getByRole("button", { name: "新增地址" }).click();
      await expect(page.getByRole("alert")).toContainText("收件地址不可超過 300 個字");
      await assertAccessibleLayout(page, viewport.width);

      // 別人的地址簿是空的
      await otherSide.page.goto("/account/addresses");
      await expect(otherSide.page.getByText("地址簿還是空的")).toBeVisible();
      await expect(otherSide.page.locator(`input[value="${HOME.address}"]`)).toHaveCount(0);

      // 結帳選用地址簿，下單
      await page.goto(`/products/${productId!}`);
      await page.getByRole("region", { name: "商品資訊" }).getByRole("button", { name: "加入購物車", exact: true }).click();
      await expect(page.locator("#cart-count")).toHaveText("1");
      await page.goto("/checkout");
      await page.getByLabel("使用地址簿").selectOption({ label: `${HOME.name}／${HOME.address}` });
      await expect(page.getByLabel("收件人電話")).toHaveValue(HOME.phone);
      await expect(page.getByLabel("收件地址")).toHaveValue(HOME.address);
      await assertAccessibleLayout(page, viewport.width);
      await page.getByLabel(/我確認配送地點位於台灣本島/).check();
      await page.getByRole("button", { name: "送出訂單" }).click();
      await expect(page).toHaveURL(/\/orders\/(\d+)\?placed=1$/);
      const orderUrl = page.url();
      await expect(page.getByText(HOME.address)).toBeVisible();

      // 修改與刪除地址簿後，舊單的收件資訊不變
      await page.goto("/account/addresses");
      const homeForm = page.locator("form", { has: page.locator(`input[value="${HOME.address}"]`) });
      await homeForm.getByLabel("收件地址").fill("高雄市前鎮區中山三路 1 號");
      await homeForm.getByRole("button", { name: /^儲存修改/ }).click();
      await expect(page.getByRole("status")).toHaveText("已儲存修改。");
      await page.getByRole("link", { name: `刪除：${OFFICE.name}／${OFFICE.address}` }).click();
      // 點連結後頁面還在導覽：等確認頁出現再量測，否則 evaluate 會落在換頁空檔
      await expect(page.getByRole("button", { name: `確認刪除：${OFFICE.name}／${OFFICE.address}` })).toBeVisible();
      await assertAccessibleLayout(page, viewport.width);
      await page.getByRole("button", { name: `確認刪除：${OFFICE.name}／${OFFICE.address}` }).click();
      await expect(page.getByRole("status")).toHaveText("已刪除地址。");
      await expect(page.locator(`input[value="${OFFICE.address}"]`)).toHaveCount(0);
      await page.goto(orderUrl.replace("?placed=1", ""));
      await expect(page.getByText(HOME.address)).toBeVisible();
      await expect(page.getByText("高雄市前鎮區中山三路 1 號")).toHaveCount(0);
    } finally {
      await context.close();
      await otherSide.context.close();
    }
  });
}
