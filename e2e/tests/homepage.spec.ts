import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { adminAccessHeaders } from "../harness/admin-access";
import { createCategory } from "../harness/admin-categories";
import { expectFeaturedWithinBudget, featureProduct } from "../harness/admin-featured";
import { featureProducts, seedListedProducts, unlistProductsByPrefix } from "../harness/admin-seed";
import { BASE_URL } from "../harness/constants";

const HOME = { slug: "e2e-home", name: "E2E首頁", description: "首頁測試用的一行說明" };
const ALPHA = { name: "首頁精選甲", priceTwd: 1200, stock: 5 };
const BETA = { name: "首頁精選乙", priceTwd: 880, stock: 5 };
const FILLER = { name: "首頁補位丙", priceTwd: 450, stock: 5 };
const SEED_PREFIXES = ["首頁精選", "首頁補位"];

// 精選與「最新上架」都是全域狀態。這個 spec 與 homepage-toast.spec.ts 在獨立的 home project 裡、等其他 spec 跑完才執行
//（見 playwright.config.ts）：它們上架的商品會擠掉 /products 第一頁，不能與找該頁商品的 spec 並行。
// 精選名額由 harness/admin-featured.ts 的 FEATURED_BUDGET 固定（兩支 spec 合計不超過首頁的 4 件），所以不論兩支並行與否，斷言都以自己標的商品為準。
test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  expectFeaturedWithinBudget("homepage", [ALPHA, BETA].length);
  const context = await browser.newContext({ baseURL: BASE_URL, extraHTTPHeaders: adminAccessHeaders() });
  try {
    const [alpha] = await seedListedProducts(context, HOME, [ALPHA, BETA, FILLER]);
    await featureProducts(context.request, [alpha!]);
  } catch (error) {
    for (const prefix of SEED_PREFIXES) await unlistProductsByPrefix(context.request, prefix);
    throw error;
  } finally { await context.close(); }
});

test.afterAll(async ({ browser }) => {
  const context = await browser.newContext({ baseURL: BASE_URL, extraHTTPHeaders: adminAccessHeaders() });
  try {
    for (const prefix of SEED_PREFIXES) await unlistProductsByPrefix(context.request, prefix);
  } finally { await context.close(); }
});

const hero = (page: Page) => page.getByRole("region", { name: "主視覺" });
const heroStatus = (page: Page) => hero(page).locator("#hero-status");
const featuredSection = (page: Page) => page.getByRole("region", { name: "精選商品" });
const categorySection = (page: Page) => page.getByRole("region", { name: "依空間選物" });
const audit = async (page: Page, name: string) => expect((await new AxeBuilder({ page }).analyze()).violations, name).toEqual([]);

test("管理員在後台標為精選後，商品出現在首頁精選區", async ({ browser, page }) => {
  const context = await browser.newContext({ baseURL: BASE_URL, extraHTTPHeaders: adminAccessHeaders() });
  try { await featureProduct(await context.newPage(), BETA.name); } finally { await context.close(); }

  await page.goto("/");
  const section = featuredSection(page);
  await expect(section.getByRole("heading", { level: 2, name: "精選商品" })).toBeVisible();
  await expect(section.getByRole("listitem").filter({ hasText: BETA.name })).toBeVisible();
  await expect(section.getByRole("listitem").filter({ hasText: ALPHA.name })).toBeVisible();
  await section.getByRole("link", { name: "全部商品" }).click();
  await expect(page).toHaveURL(/\/products$/);
});

test("首頁分類方塊有名稱、說明與箭頭，整塊連到分類頁；手機 2 欄、桌機 4 欄", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const tiles = categorySection(page).getByRole("list");
  expect(await tiles.evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length)).toBe(2);
  await page.setViewportSize({ width: 1280, height: 900 });
  expect(await tiles.evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length)).toBe(4);

  const tile = categorySection(page).getByRole("link", { name: new RegExp(HOME.name) });
  await expect(tile).toContainText(HOME.description);
  await tile.click();
  await expect(page).toHaveURL(new RegExp(`/categories/${HOME.slug}$`));
  await expect(page.getByRole("heading", { level: 1, name: HOME.name })).toBeVisible();
});

test("精選卡片可以直接加入購物車，顯示 toast 並更新件數", async ({ page }) => {
  await page.goto("/");
  const card = featuredSection(page).getByRole("listitem").filter({ hasText: ALPHA.name });
  await card.getByRole("button", { name: "加入購物車" }).click();
  await expect(card.getByRole("status")).toHaveText("已加入購物車，目前 1 件。");
  await expect(page.locator("#cart-count")).toHaveText("1");
});

test("商品卡：封面是正方形，加入購物車是只有圖示的按鈕，但有完整的無障礙名稱", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  const card = featuredSection(page).getByRole("listitem").filter({ hasText: ALPHA.name });
  // 封面：寬高相差不到 1px（版面以 aspect-ratio 撐成方形，不是靠圖片原始比例）
  const cover = (await card.getByAltText(ALPHA.name, { exact: true }).boundingBox())!;
  expect(Math.abs(cover.width - cover.height)).toBeLessThan(1);
  // 按鈕：名稱帶商品名、內容是 svg 圖示、畫面上沒有可見文字
  const add = card.getByRole("button", { name: `加入購物車：${ALPHA.name}` });
  await expect(add.locator("svg")).toHaveCount(1);
  expect((await add.innerText()).trim()).toBe("");
});

// 後台清單的原價欄由 sale.spec.ts 斷言；這裡只驗精選欄
test("後台商品清單：精選欄顯示「精選」，按鈕改為取消精選", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: BASE_URL, extraHTTPHeaders: adminAccessHeaders() });
  try {
    const admin = await context.newPage();
    await admin.goto("/admin");
    // 精選欄以表頭位置定位：原價欄對未特價商品也是「—」，不能用文字找
    const headers = await admin.locator("thead th").allTextContents();
    const featuredColumn = headers.indexOf("精選");
    expect(featuredColumn, "後台清單要有「精選」欄").toBeGreaterThanOrEqual(0);
    const featuredCell = (name: string) => admin.getByRole("row", { name: new RegExp(name) }).locator("td").nth(featuredColumn);
    await expect(featuredCell(ALPHA.name)).toContainText(/^精選/);
    await expect(featuredCell(ALPHA.name).getByRole("button", { name: `取消精選：${ALPHA.name}` })).toBeVisible();
    // 沒標精選的商品是「—」，按鈕是標為精選
    await expect(featuredCell(FILLER.name)).toContainText(/^—/);
    await expect(featuredCell(FILLER.name).getByRole("button", { name: `標為精選：${FILLER.name}` })).toBeVisible();
  } finally { await context.close(); }
});

test("沒有上架商品的分類不出現在首頁分類方塊與導覽列，其他分類照常出現", async ({ browser, page }) => {
  const EMPTY = { slug: "e2e-empty-home", name: "E2E空", description: "沒有上架商品的分類" };
  const context = await browser.newContext({ baseURL: BASE_URL, extraHTTPHeaders: adminAccessHeaders() });
  try {
    const admin = await context.newPage();
    await createCategory(admin, EMPTY);
    await expect(admin.getByRole("status")).toHaveText("已建立分類。");
  } finally { await context.close(); }

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  await expect(categorySection(page).getByRole("link", { name: new RegExp(HOME.name) })).toBeVisible();
  await expect(categorySection(page).getByRole("link", { name: new RegExp(`^${EMPTY.name}`) })).toHaveCount(0);
  const nav = page.getByRole("navigation", { name: "主要導覽" });
  await expect(nav.getByRole("link", { name: HOME.name })).toBeVisible();
  await expect(nav.getByRole("link", { name: EMPTY.name, exact: true })).toHaveCount(0);
});

test("主視覺：版面預留尺寸、第一張優先載入，其餘延後；可用鍵盤切換與暫停", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.clock.install();
  await page.goto("/");
  const carousel = hero(page);
  await expect(carousel).toHaveAttribute("aria-roledescription", "carousel");
  const slides = carousel.locator("[aria-roledescription=slide]");
  await expect(slides).toHaveCount(3);
  await expect(slides.first()).toHaveAttribute("aria-roledescription", "slide");
  await expect(slides.nth(1)).toHaveAttribute("aria-label", "第 2 張，共 3 張");

  const images = carousel.locator("img");
  await expect(images.first()).toHaveAttribute("loading", "eager");
  await expect(images.first()).toHaveAttribute("fetchpriority", "high");
  await expect(images.nth(1)).toHaveAttribute("loading", "lazy");
  await expect(images.first()).toHaveAttribute("srcset", /640w.*1024w.*1600w/);
  await expect(images.first()).toHaveAttribute("sizes", /.+/);
  await expect(images.first()).toHaveAttribute("width", "1600");
  await expect(images.first()).toHaveAttribute("height", "914");
  for (const [index, label, href] of [[0, "逛客廳選物", "/categories/living"], [1, "逛餐廳選物", "/categories/dining"], [2, "逛工作區選物", "/categories/workspace"]] as const) {
    await expect(slides.nth(index).getByRole("link", { name: label, includeHidden: true })).toHaveAttribute("href", href);
  }

  await expect(heroStatus(page)).toHaveText("1 / 3");
  // 只有目前這張可聚焦；軌道本身不是 tab stop；切換後 inert 跟著換
  await expect(slides.nth(0)).not.toHaveJSProperty("inert", true);
  await expect(slides.nth(1)).toHaveJSProperty("inert", true);
  await expect(carousel.locator("#hero-track")).not.toHaveAttribute("tabindex", /.*/);
  await carousel.getByRole("button", { name: "下一張" }).focus();
  await page.keyboard.press("Enter");
  await expect(heroStatus(page)).toHaveText("2 / 3");
  await expect(slides.nth(0)).toHaveJSProperty("inert", true);
  await expect(slides.nth(1)).not.toHaveJSProperty("inert", true);
  await expect.poll(() => carousel.locator("#hero-track").evaluate((track) => Math.round(track.scrollLeft / track.clientWidth))).toBe(1);
  await carousel.getByRole("button", { name: "上一張" }).focus();
  await page.keyboard.press("Enter");
  await expect(heroStatus(page)).toHaveText("1 / 3");
  await carousel.getByRole("button", { name: "上一張" }).focus();
  await page.keyboard.press("Enter");
  await expect(heroStatus(page)).toHaveText("3 / 3");

  // 暫停：按鈕名稱換成「播放」，超過一個切換間隔仍停在同一張；焦點離開輪播也不會恢復
  await carousel.getByRole("button", { name: "暫停自動輪播" }).focus();
  await page.keyboard.press("Enter");
  await expect(carousel.getByRole("button", { name: "播放自動輪播" })).toBeVisible();
  await page.mouse.move(5, 5);
  await page.locator("#main-content").focus();
  await page.clock.fastForward(7000);
  await expect(heroStatus(page)).toHaveText("3 / 3");

  // 播放：焦點與滑鼠都離開輪播後，6 秒內自動換到下一張（第 3 張接回第 1 張）
  await carousel.getByRole("button", { name: "播放自動輪播" }).focus();
  await page.keyboard.press("Enter");
  await expect(carousel.getByRole("button", { name: "暫停自動輪播" })).toBeVisible();
  await page.locator("#main-content").focus();
  await page.clock.fastForward(6000);
  await expect(heroStatus(page)).toHaveText("1 / 3");
});

test("主視覺：焦點或滑鼠在輪播內時暫停自動輪播", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.clock.install();
  await page.goto("/");
  const carousel = hero(page);
  await carousel.getByRole("button", { name: "下一張" }).focus();
  await page.clock.fastForward(7000);
  await expect(heroStatus(page)).toHaveText("1 / 3");
  await page.locator("#main-content").focus();
  const box = (await carousel.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 3);
  await page.clock.fastForward(7000);
  await expect(heroStatus(page)).toHaveText("1 / 3");
});

test("減少動態效果時主視覺不自動輪播、不顯示暫停按鈕", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.clock.install();
  await page.goto("/");
  const carousel = hero(page);
  await expect(heroStatus(page)).toHaveText("1 / 3");
  await page.clock.fastForward(7000);
  await expect(heroStatus(page)).toHaveText("1 / 3");
  expect(await carousel.locator("#hero-track").evaluate((track) => track.scrollLeft)).toBe(0);
  await expect(carousel.getByRole("button", { name: /自動輪播/ })).toBeHidden();
  // 手動切換仍可用，而且沒有轉場：下一張立即到位
  await carousel.getByRole("button", { name: "下一張" }).click();
  await expect(heroStatus(page)).toHaveText("2 / 3");
  await expect.poll(() => carousel.locator("#hero-track").evaluate((track) => Math.round(track.scrollLeft / track.clientWidth))).toBe(1);
});

test.describe("沒有 JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("主視覺顯示第一張、控制列不出現，其餘張數可捲動瀏覽", async ({ page }) => {
    await page.goto("/");
    const carousel = hero(page);
    await expect(carousel.locator("#hero-controls")).toBeHidden();
    // 軌道可用鍵盤聚焦捲動，有名稱
    const track = carousel.getByRole("group", { name: "主視覺投影片" });
    await expect(track).toHaveAttribute("tabindex", "0");
    await track.focus();
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => track.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
    await expect(carousel.getByRole("heading", { level: 2 }).first()).toBeVisible();
    expect(await carousel.locator("#hero-track").evaluate((track) => track.scrollWidth > track.clientWidth)).toBe(true);
  });
});

for (const [width, height] of [[375, 844], [1280, 900]] as const) {
  test(`首頁（${width}px）：沒有橫向捲動、編輯式橫幅連到全部商品、axe 零違規`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height });
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(page.getByRole("region", { name: "日常，從喜歡的物件開始" }).getByRole("link", { name: "全部商品", exact: true })).toHaveAttribute("href", "/products");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    // 圖片都載入完成後再量測、截圖
    await page.evaluate(async () => {
      await Promise.all([...document.images].map((image) => { image.loading = "eager"; return image.decode().catch(() => undefined); }));
    });
    await audit(page, `首頁（${width}px）`);
    await testInfo.attach(`home-${width}`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
  });
}
