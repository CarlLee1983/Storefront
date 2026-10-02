import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { adminAccessHeaders } from "../harness/admin-access";
import { seedListedProducts, unlistProductsByPrefix } from "../harness/admin-seed";
import { BASE_URL } from "../harness/constants";

const CATEGORY = { slug: "e2e-sale", name: "E2E特價", description: "特價測試用的一行說明" };
const SALE = { name: "特價測試杯", priceTwd: 320, compareAtPriceTwd: 450 };
const REGULAR = { name: "特價測試平價杯", priceTwd: 200 };
const SEED_PREFIX = "特價測試";

const card = (page: Page, name: string) => page.locator(".product-card").filter({ has: page.getByRole("heading", { level: 2, name, exact: true }) });
const saleNavLink = (page: Page) => page.getByRole("navigation", { name: "主要導覽" }).getByRole("link", { name: "特價", exact: true });
const audit = async (page: Page, name: string) => expect((await new AxeBuilder({ page }).analyze()).violations, name).toEqual([]);
const adminCell = (page: Page, name: string, column: "原價" | "狀態") => page.getByRole("row", { name: new RegExp(name) })
  .locator("td").nth({ 原價: 4, 狀態: 8 }[column]);

/** 在商品編輯頁填寫（空字串為清空）原價並儲存；回傳送出後頁面（成功時是後台清單，被拒時停在編輯頁）。 */
async function saveCompareAt(admin: Page, name: string, compareAt: string, priceTwd?: number) {
  await admin.goto("/admin");
  await admin.getByRole("row", { name: new RegExp(name) }).getByRole("link", { name: "編輯" }).click();
  if (priceTwd !== undefined) await admin.getByLabel("單價（新台幣整數元）").fill(String(priceTwd));
  await admin.getByLabel("原價（選填）").fill(compareAt);
  await admin.getByRole("button", { name: "儲存" }).click();
}

// 這支 spec 在獨立的 sale project 裡、等其他 spec 跑完才執行（見 playwright.config.ts）：
// 「有沒有特價商品」是全域狀態（導覽列的特價入口、/sale 的空狀態），不能與其他 spec 並行。
// 以下測試依序執行：先設定特價、再結束特價；用完下架，依名稱前綴找，建立到一半失敗也清得掉。
test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({ baseURL: BASE_URL, extraHTTPHeaders: adminAccessHeaders() });
  try {
    await seedListedProducts(context, CATEGORY, [
      { name: SALE.name, priceTwd: SALE.priceTwd, stock: 5 },
      { name: REGULAR.name, priceTwd: REGULAR.priceTwd, stock: 5 },
    ]);
  } catch (error) {
    await unlistProductsByPrefix(context.request, SEED_PREFIX);
    throw error;
  } finally { await context.close(); }
});

test.afterAll(async ({ browser }) => {
  const context = await browser.newContext({ baseURL: BASE_URL, extraHTTPHeaders: adminAccessHeaders() });
  try { await unlistProductsByPrefix(context.request, SEED_PREFIX); } finally { await context.close(); }
});

test("沒有特價商品時：導覽列沒有「特價」，/sale 是 200 的空狀態，axe 零違規", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const response = await page.goto("/sale");
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1, name: "特價" })).toBeVisible();
  await expect(page.getByText("目前沒有特價商品。")).toBeVisible();
  await expect(page.locator(".product-card")).toHaveCount(0);
  await expect(saleNavLink(page)).toHaveCount(0);
  await audit(page, "/sale 空狀態");
});

test("管理員拒絕不高於售價的原價，設定合法原價後顧客在商品卡、詳情頁與 /sale 都看到劃線價與標籤", async ({ browser, page }) => {
  const context = await browser.newContext({ baseURL: BASE_URL, extraHTTPHeaders: adminAccessHeaders() });
  try {
    const admin = await context.newPage();
    await saveCompareAt(admin, SALE.name, String(SALE.priceTwd));
    await expect(admin.getByRole("alert")).toContainText("原價必須高於這次儲存後的售價");
    await saveCompareAt(admin, SALE.name, String(SALE.compareAtPriceTwd));
    await expect(admin.getByRole("status")).toHaveText("已儲存商品。");
    await expect(adminCell(admin, SALE.name, "原價")).toHaveText("450");
    await expect(adminCell(admin, REGULAR.name, "原價")).toHaveText("—");
  } finally { await context.close(); }

  await page.setViewportSize({ width: 1280, height: 900 });
  // 分類列表：特價商品的售價、劃線原價（帶螢幕閱讀器文字「原價」）與折扣標籤；一般商品沒有
  await page.goto(`/categories/${CATEGORY.slug}`);
  const saleCard = card(page, SALE.name);
  await expect(saleCard).toContainText("NT$ 320");
  await expect(saleCard.locator("s")).toHaveText(/原價\s*NT\$\s*450/);
  await expect(saleCard.locator(".sale-tag")).toContainText("−29%");
  await expect(card(page, REGULAR.name).locator("s")).toHaveCount(0);
  await expect(card(page, REGULAR.name).locator(".sale-tag")).toHaveCount(0);

  // 只看特價：只剩特價商品，網址帶 sale=1
  await page.getByRole("checkbox", { name: "只看特價" }).click();
  await expect(page).toHaveURL(/\?sale=1$/);
  await expect(page.getByRole("checkbox", { name: "只看特價" })).toBeChecked();
  await expect(page.locator(".product-card")).toHaveCount(1);
  await expect(saleCard).toBeVisible();

  // 導覽列出現「特價」，在 /sale 時標示目前頁；/sale 不顯示「只看特價」開關
  await expect(saleNavLink(page)).toBeVisible();
  await saleNavLink(page).click();
  await expect(page).toHaveURL(/\/sale$/);
  await expect(saleNavLink(page)).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { level: 1, name: "特價" })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "只看特價" })).toHaveCount(0);
  await expect(saleCard).toBeVisible();
  await expect(card(page, REGULAR.name)).toHaveCount(0);

  // 詳情頁
  await saleCard.getByRole("link").first().click();
  const information = page.getByRole("region", { name: "商品資訊" });
  await expect(information).toContainText("NT$ 320");
  await expect(information.locator("s")).toHaveText(/原價\s*NT\$\s*450/);
  await expect(information.locator(".sale-tag")).toContainText("−29%");

  // 加入購物車後，購物車只記得售價，不顯示原價
  await information.getByRole("button", { name: "加入購物車", exact: true }).click();
  await expect(information.getByRole("status")).toHaveText("已加入購物車，目前 1 件。");
  await page.goto("/cart");
  await expect(page.getByRole("main")).toContainText("NT$ 320");
  await expect(page.getByRole("main")).not.toContainText("450");
  await expect(page.getByRole("main")).not.toContainText("原價");
});

test("/sale 有特價商品時桌機與手機 axe 零違規，手機抽屜也有「特價」", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/sale");
  await expect(card(page, SALE.name)).toBeVisible();
  await audit(page, "/sale 桌機");
  await page.goto(`/products/${(await card(page, SALE.name).getByRole("link").first().getAttribute("href"))!.split("/").pop()}`);
  await audit(page, "特價詳情頁");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/sale");
  await audit(page, "/sale 手機");
  await page.getByRole("button", { name: "開啟選單" }).click();
  const drawerLink = page.getByRole("navigation", { name: "行動版導覽" }).getByRole("link", { name: "特價", exact: true });
  await expect(drawerLink).toHaveAttribute("aria-current", "page");
});

test("特價商品下架後：後台狀態更新，導覽列不再有「特價」；重新上架後回來", async ({ browser, page }) => {
  const context = await browser.newContext({ baseURL: BASE_URL, extraHTTPHeaders: adminAccessHeaders() });
  try {
    const admin = await context.newPage();
    await admin.goto("/admin");
    const row = admin.getByRole("row", { name: new RegExp(SALE.name) });
    await expect(adminCell(admin, SALE.name, "原價")).toHaveText("450");
    await row.getByRole("button", { name: "下架" }).click();
    await expect(admin.getByRole("status")).toHaveText("已下架商品。");
    await expect(adminCell(admin, SALE.name, "原價")).toHaveText("450");
    await expect(adminCell(admin, SALE.name, "狀態")).toHaveText("已下架");

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/sale");
    await expect(page.getByText("目前沒有特價商品。")).toBeVisible();
    await expect(saleNavLink(page)).toHaveCount(0);

    await row.getByRole("button", { name: "重新上架" }).click();
    await expect(admin.getByRole("status")).toHaveText("已重新上架商品。");
    await expect(adminCell(admin, SALE.name, "原價")).toHaveText("450");
    await expect(adminCell(admin, SALE.name, "狀態")).toHaveText("上架中");
  } finally { await context.close(); }
});

test("結束特價：同一次儲存改回售價並清空原價後，導覽列不再顯示「特價」，/sale 顯示空狀態", async ({ browser, page }) => {
  const context = await browser.newContext({ baseURL: BASE_URL, extraHTTPHeaders: adminAccessHeaders() });
  try {
    const admin = await context.newPage();
    await saveCompareAt(admin, SALE.name, "", SALE.compareAtPriceTwd);
    await expect(admin.getByRole("status")).toHaveText("已儲存商品。");
    await expect(adminCell(admin, SALE.name, "原價")).toHaveText("—");
  } finally { await context.close(); }

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/categories/${CATEGORY.slug}`);
  await expect(card(page, SALE.name)).toContainText("NT$ 450");
  await expect(card(page, SALE.name).locator("s")).toHaveCount(0);
  await expect(saleNavLink(page)).toHaveCount(0);
  const response = await page.goto("/sale");
  expect(response?.status()).toBe(200);
  await expect(page.getByText("目前沒有特價商品。")).toBeVisible();
  await audit(page, "/sale 結束特價後的空狀態");
});
