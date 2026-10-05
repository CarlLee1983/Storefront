import { expect, test, type Page } from "@playwright/test";
import { adminAccessHeaders } from "../harness/admin-access";
import { seedListedProducts, unlistProductsByPrefix } from "../harness/admin-seed";
import { BASE_URL } from "../harness/constants";
import { analyzeWhenSettled } from "../harness/axe";

const LISTING = { slug: "e2e-listing", name: "E2E列表", description: "列表測試用的一行說明" };
const SOLD_OUT = { slug: "e2e-soldout", name: "E2E售完", description: "只有售完商品的分類" };

// 30 件商品：售價隨編號遞增（編號 n → 100 + 10n）；6 的倍數已售完，其餘有貨（25 件）
const NUMBERS = Array.from({ length: 30 }, (_, index) => index + 1);
const productName = (n: number) => `列表商品 ${String(n).padStart(2, "0")}`;
const LISTING_PRODUCTS = NUMBERS.map((n) => ({ name: productName(n), priceTwd: 100 + 10 * n, stock: n % 6 === 0 ? 0 : 5 }));
const SOLD_OUT_PRODUCT = { name: "列表售完商品", priceTwd: 300, stock: 0 };

const cards = (page: Page) => page.locator(".product-card");
const firstCardName = (page: Page) => cards(page).first().getByRole("heading", { level: 2 });
const sortLink = (page: Page, label: string) => page.getByRole("navigation", { name: "排序" }).getByRole("link", { name: label });
const stockSwitch = (page: Page) => page.getByRole("checkbox", { name: "只看有貨" });
const audit = async (page: Page, name: string) => expect((await analyzeWhenSettled(page)).violations, name).toEqual([]);

const SEED_PREFIX = "列表";

// 這支 spec 在獨立的 listing project 裡、等其他 spec 跑完才執行（見 playwright.config.ts）：
// 31 件商品會擠掉首頁第一頁，不能與找首頁商品的 spec 並行。用完仍下架；依名稱前綴找，建立到一半失敗也清得掉。
test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({ baseURL: BASE_URL, extraHTTPHeaders: adminAccessHeaders() });
  try {
    await seedListedProducts(context, LISTING, LISTING_PRODUCTS);
    await seedListedProducts(context, SOLD_OUT, [SOLD_OUT_PRODUCT]);
  } catch (error) {
    await unlistProductsByPrefix(context.request, SEED_PREFIX);
    throw error;
  } finally { await context.close(); }
});

test.afterAll(async ({ browser }) => {
  const context = await browser.newContext({ baseURL: BASE_URL, extraHTTPHeaders: adminAccessHeaders() });
  try { await unlistProductsByPrefix(context.request, SEED_PREFIX); } finally { await context.close(); }
});

test("分類頁：排序、只看有貨、載入更多都在網址上，重新整理與上一頁都能還原", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/categories/${LISTING.slug}`);
  await expect(page.getByRole("heading", { level: 1, name: LISTING.name })).toBeVisible();

  // 預設：新上架，第一頁 24 件
  await expect(cards(page)).toHaveCount(24);
  await expect(page.getByText("分類共 30 件商品")).toBeVisible();
  await expect(page.getByText("已顯示 24 / 30 件")).toBeVisible();
  await expect(firstCardName(page)).toHaveText(productName(30));
  await expect(sortLink(page, "新上架")).toHaveAttribute("aria-current", "true");
  await expect(stockSwitch(page)).not.toBeChecked();

  // 載入更多：連到 page=2，累計顯示全部 30 件，已經沒有更多
  await page.getByRole("link", { name: "載入更多" }).click();
  await expect(page).toHaveURL(/\?page=2$/);
  await expect(cards(page)).toHaveCount(30);
  await expect(page.getByText("已顯示 30 / 30 件")).toBeVisible();
  await expect(page.getByRole("link", { name: "載入更多" })).toHaveCount(0);

  // 切換排序：頁數重置為 1
  await sortLink(page, "價格低到高").click();
  await expect(page).toHaveURL(/\?sort=price-asc$/);
  await expect(sortLink(page, "價格低到高")).toHaveAttribute("aria-current", "true");
  await expect(sortLink(page, "新上架")).not.toHaveAttribute("aria-current", "true");
  await expect(cards(page)).toHaveCount(24);
  await expect(firstCardName(page)).toHaveText(productName(1));
  await sortLink(page, "價格高到低").click();
  await expect(firstCardName(page)).toHaveText(productName(30));
  await sortLink(page, "價格低到高").click();

  // 只看有貨：保留排序、售完的商品消失、總數變 25
  await stockSwitch(page).click();
  await expect(page).toHaveURL(/\?sort=price-asc&instock=1$/);
  await expect(stockSwitch(page)).toBeChecked();
  await expect(cards(page)).toHaveCount(24);
  await expect(page.getByText("分類共 30 件商品")).toBeVisible();
  await expect(page.getByText("符合條件 25 件，已顯示 24 件")).toBeVisible();
  await expect(page.getByText("已售完")).toHaveCount(0);
  await expect(firstCardName(page)).toHaveText(productName(1));
  await page.getByRole("link", { name: "載入更多" }).click();
  await expect(page).toHaveURL(/\?sort=price-asc&instock=1&page=2$/);
  await expect(page.getByText("符合條件 25 件，已顯示 25 件")).toBeVisible();

  // 重新整理：狀態全部還原
  await page.reload();
  await expect(sortLink(page, "價格低到高")).toHaveAttribute("aria-current", "true");
  await expect(stockSwitch(page)).toBeChecked();
  await expect(page.getByText("符合條件 25 件，已顯示 25 件")).toBeVisible();
  await expect(cards(page)).toHaveCount(25);
  await audit(page, "分類頁（排序、只看有貨、第 2 頁）");

  // 上一頁回到第 1 頁；關掉只看有貨回到 30 件的列表
  await page.goBack();
  await expect(page).toHaveURL(/\?sort=price-asc&instock=1$/);
  await expect(page.getByText("符合條件 25 件，已顯示 24 件")).toBeVisible();
  await stockSwitch(page).click();
  await expect(page).toHaveURL(/\?sort=price-asc$/);
  await expect(stockSwitch(page)).not.toBeChecked();
  await expect(page.getByText("已顯示 24 / 30 件")).toBeVisible();

  // 非法的參數回到預設，不出錯
  await page.goto(`/categories/${LISTING.slug}?sort=random&instock=yes&page=999`);
  await expect(page.getByText("已顯示 24 / 30 件")).toBeVisible();
  await expect(sortLink(page, "新上架")).toHaveAttribute("aria-current", "true");
});

test("搜尋結果頁：載入更多連到 page=2，累計顯示全部結果，重新整理仍是 30 件", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/search?q=${encodeURIComponent("列表商品")}`);
  await expect(cards(page)).toHaveCount(24);
  await expect(page.getByText("已顯示 24 / 30 件")).toBeVisible();
  await page.getByRole("link", { name: "載入更多" }).click();
  await expect(page).toHaveURL(/page=2/);
  await expect(cards(page)).toHaveCount(30);
  await expect(page.getByText("已顯示 30 / 30 件")).toBeVisible();
  await expect(page.getByRole("link", { name: "載入更多" })).toHaveCount(0);
  await page.reload();
  await expect(cards(page)).toHaveCount(30);
  await expect(page.getByText("已顯示 30 / 30 件")).toBeVisible();
});

test("鍵盤操作：排序連結按 Enter，只看有貨的 checkbox 按 Space", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/categories/${LISTING.slug}`);
  await sortLink(page, "價格高到低").focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\?sort=price-desc$/);
  await stockSwitch(page).focus();
  await page.keyboard.press("Space");
  await expect(page).toHaveURL(/\?sort=price-desc&instock=1$/);
  await expect(stockSwitch(page)).toBeChecked();
  await stockSwitch(page).focus();
  await page.keyboard.press("Space");
  await expect(page).toHaveURL(/\?sort=price-desc$/);
  await expect(stockSwitch(page)).not.toBeChecked();
});

test("全部商品頁：導覽列連到 /products，同一套列表區塊，桌機與手機 axe 零違規", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "主要導覽" });
  await nav.getByRole("link", { name: "全部商品" }).click();
  await expect(page).toHaveURL(/\/products$/);
  await expect(page.getByRole("heading", { level: 1, name: "全部商品" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "全部商品" })).toHaveAttribute("aria-current", "page");
  await expect(cards(page)).toHaveCount(24);
  await expect(page.getByText(/已顯示 24 \/ \d+ 件/)).toBeVisible();
  await expect(page.getByRole("link", { name: "載入更多" })).toBeVisible();
  await expect(sortLink(page, "價格高到低")).toBeVisible();
  await audit(page, "全部商品頁（桌機）");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "開啟選單" }).click();
  await page.getByRole("dialog", { name: "選單" }).getByRole("link", { name: "全部商品" }).click();
  await expect(page).toHaveURL(/\/products$/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await audit(page, "全部商品頁（手機）");
});

test("篩選後沒有商品：顯示空狀態與清除篩選，清除後回到沒有篩選的網址；axe 零違規", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/categories/${SOLD_OUT.slug}`);
  await expect(page.getByText("已顯示 1 / 1 件")).toBeVisible();
  await stockSwitch(page).click();
  await expect(page).toHaveURL(/\?instock=1$/);
  await expect(page.getByText("目前沒有符合條件的商品。")).toBeVisible();
  await expect(page.getByText("分類共 1 件商品")).toBeVisible();
  await expect(page.getByText("符合條件 0 件")).toBeVisible();
  await expect(cards(page)).toHaveCount(0);
  await expect(page.getByText(/已顯示/)).toHaveCount(0);
  await audit(page, "篩選後的空狀態");

  await page.getByRole("link", { name: "清除篩選" }).click();
  await expect(page).toHaveURL(new RegExp(`/categories/${SOLD_OUT.slug}$`));
  await expect(cards(page)).toHaveCount(1);
  await expect(stockSwitch(page)).not.toBeChecked();
});
