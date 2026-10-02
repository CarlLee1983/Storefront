import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { adminAccessHeaders } from "../harness/admin-access";
import { seedListedProducts, unlistProductsByPrefix } from "../harness/admin-seed";
import { BASE_URL } from "../harness/constants";

// 名稱前綴獨特，避免與其他 spec 的商品互相干擾；說明由 seed 產生為「{名稱}的說明」
const SEED_PREFIX = "搜尋測試";
const CATEGORY = { slug: "e2e-search", name: "E2E搜尋", description: "搜尋測試用的一行說明" };
const SEARCH_PRODUCTS = [
  { name: `${SEED_PREFIX} Aurora 弧形單椅`, priceTwd: 3200, stock: 5 },
  { name: `${SEED_PREFIX} 邊桌`, priceTwd: 1800, stock: 0 },
];
const AURORA = SEARCH_PRODUCTS[0]!.name;

const audit = async (page: Page, name: string) => expect((await new AxeBuilder({ page }).analyze()).violations, name).toEqual([]);
const cards = (page: Page) => page.locator(".product-card");
const headerSearchButton = (page: Page) => page.getByRole("banner").getByRole("button", { name: "搜尋", exact: true });

test.beforeAll(async ({ browser }) => {
  test.setTimeout(60_000);
  const context = await browser.newContext({ baseURL: BASE_URL, extraHTTPHeaders: adminAccessHeaders() });
  try {
    await seedListedProducts(context, CATEGORY, SEARCH_PRODUCTS);
  } catch (error) {
    await unlistProductsByPrefix(context.request, SEED_PREFIX);
    throw error;
  } finally { await context.close(); }
});

test.afterAll(async ({ browser }) => {
  const context = await browser.newContext({ baseURL: BASE_URL, extraHTTPHeaders: adminAccessHeaders() });
  try { await unlistProductsByPrefix(context.request, SEED_PREFIX); } finally { await context.close(); }
});

test.describe("桌機搜尋", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("header 搜尋框搜尋（不分大小寫），進入結果中的商品；重新整理保留結果", async ({ page }) => {
    await page.goto("/");
    await headerSearchButton(page).click();
    const dialog = page.getByRole("dialog", { name: "搜尋" });
    await dialog.getByRole("searchbox", { name: "搜尋商品" }).fill("aURORA");
    await page.keyboard.press("Enter");

    await expect(page).toHaveURL(/\/search\?q=aURORA$/);
    await expect(page.getByRole("heading", { level: 1, name: "搜尋：aURORA" })).toBeVisible();
    await expect(cards(page)).toHaveCount(1);
    await expect(page.getByText("已顯示 1 / 1 件")).toBeVisible();
    // 結果頁的搜尋表單預先填入關鍵字
    await expect(page.getByRole("search", { name: "重新搜尋" }).getByRole("searchbox")).toHaveValue("aURORA");

    await page.reload();
    await expect(cards(page)).toHaveCount(1);
    await expect(cards(page).first().getByRole("heading", { level: 2 })).toHaveText(AURORA);

    await cards(page).first().getByRole("link").first().click();
    await expect(page.getByRole("heading", { level: 1, name: AURORA })).toBeVisible();
  });

  test("說明也能命中；結果頁可排序並保留關鍵字", async ({ page }) => {
    await page.goto(`/search?q=${encodeURIComponent(`${SEED_PREFIX} 邊桌的說明`)}`);
    await expect(cards(page)).toHaveCount(1);

    await page.goto(`/search?q=${encodeURIComponent(SEED_PREFIX)}`);
    await expect(cards(page)).toHaveCount(2);
    await page.getByRole("navigation", { name: "排序" }).getByRole("link", { name: "價格低到高" }).click();
    await expect(page).toHaveURL(new RegExp(`q=${encodeURIComponent(SEED_PREFIX)}&sort=price-asc$`));
    await expect(cards(page).first().getByRole("heading", { level: 2 })).toHaveText(`${SEED_PREFIX} 邊桌`);
  });

  test("搜尋 dialog 的焦點管理：開啟時焦點在輸入框，Esc 關閉後回到圖示按鈕", async ({ page }) => {
    await page.goto("/");
    const button = headerSearchButton(page);
    const dialog = page.getByRole("dialog", { name: "搜尋" });
    await expect(dialog).toBeHidden();

    await button.click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("searchbox", { name: "搜尋商品" })).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(button).toBeFocused();
  });

  test("沒有結果時顯示提示與前往全部商品的連結；%、_ 當成一般文字", async ({ page }) => {
    await page.goto("/search?q=%25_%25");
    await expect(page.getByText("找不到符合「%_%」的商品")).toBeVisible();
    await page.locator(".listing-empty").getByRole("link", { name: "全部商品" }).click();
    await expect(page).toHaveURL(/\/products$/);
  });

  test("搜尋有命中但開了只看有貨而沒有結果：說明原因並可清除篩選", async ({ page }) => {
    const q = `${SEED_PREFIX} 邊桌`;
    await page.goto(`/search?q=${encodeURIComponent(q)}&instock=1`);
    await expect(page.getByText(`找不到符合「${q}」的商品。試著清除篩選條件。`)).toBeVisible();
    await page.getByRole("link", { name: "清除篩選" }).click();
    await expect(page).not.toHaveURL(/instock/);
    await expect(page).toHaveURL(/\/search\?q=/);
    await expect(cards(page)).toHaveCount(1);
  });

  test("空白關鍵字導向全部商品；超過長度上限顯示錯誤而不是 500", async ({ page }) => {
    await page.goto("/search?q=%20%20");
    await expect(page).toHaveURL(/\/products$/);

    const response = await page.goto(`/search?q=${"a".repeat(51)}`);
    expect(response?.status()).toBe(400);
    await expect(page.getByRole("alert")).toHaveText("搜尋文字太長，請縮短後再試。");
  });

  test("axe：搜尋結果頁、沒有結果、打開的搜尋 dialog 都零違規", async ({ page }) => {
    await page.goto("/search?q=aurora");
    await expect(cards(page)).toHaveCount(1);
    await audit(page, "搜尋結果頁");

    await page.goto("/search?q=zzzz-no-such-product");
    await expect(page.getByText("找不到符合「zzzz-no-such-product」的商品")).toBeVisible();
    await audit(page, "沒有結果");

    await headerSearchButton(page).click();
    await expect(page.getByRole("dialog", { name: "搜尋" })).toBeVisible();
    await audit(page, "打開的搜尋 dialog");
  });
});

test.describe("手機搜尋", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("header 的搜尋按鈕在手機也有，開同一個搜尋 dialog 並搜尋", async ({ page }) => {
    await page.goto("/");
    await headerSearchButton(page).click();
    const dialog = page.getByRole("dialog", { name: "搜尋" });
    await expect(dialog.getByRole("searchbox", { name: "搜尋商品" })).toBeFocused();
    await page.keyboard.type("aurora");
    await page.keyboard.press("Enter");

    await expect(page).toHaveURL(/\/search\?q=aurora$/);
    await expect(cards(page)).toHaveCount(1);
  });

  test("搜尋 dialog 開著時視窗縮到手機寬度，dialog 仍然可見、可以關閉", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/");
    const button = headerSearchButton(page);
    const dialog = page.getByRole("dialog", { name: "搜尋" });
    await button.click();
    await expect(dialog).toBeVisible();

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(dialog).toBeVisible();
    await page.getByRole("button", { name: "關閉搜尋" }).click();
    await expect(dialog).toBeHidden();
    await expect(button).toBeFocused();
  });

  test("選單抽屜頂端的搜尋框搜尋並進入結果中的商品；重新整理保留結果", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "開啟選單" }).click();
    const drawer = page.getByRole("dialog", { name: "選單" });
    await drawer.getByRole("searchbox", { name: "搜尋商品" }).fill("aurora");
    await drawer.getByRole("button", { name: "搜尋", exact: true }).click();

    await expect(page).toHaveURL(/\/search\?q=aurora$/);
    await expect(cards(page)).toHaveCount(1);
    await page.reload();
    await expect(page).toHaveURL(/\/search\?q=aurora$/);
    await expect(cards(page)).toHaveCount(1);
    await expect(cards(page).first().getByRole("heading", { level: 2 })).toHaveText(AURORA);

    await cards(page).first().getByRole("link").first().click();
    await expect(page.getByRole("heading", { level: 1, name: AURORA })).toBeVisible();
  });
});
