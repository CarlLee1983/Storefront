import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { adminAccessHeaders } from "../harness/admin-access";
import { assignCategory, createCategory } from "../harness/admin-categories";
import { BASE_URL } from "../harness/constants";

const LIVING = { slug: "e2e-living", name: "E2E客廳", description: "分類頁測試用的一行說明" };

async function createProduct(admin: Page, name: string) {
  await admin.goto("/admin");
  await admin.getByLabel("名稱", { exact: true }).fill(name);
  await admin.getByLabel("說明", { exact: true }).fill("分類測試商品");
  await admin.getByLabel("單價（新台幣整數元）").fill("880");
  await admin.getByRole("button", { name: "新增商品", exact: true }).click();
  await expect(admin.getByRole("status")).toHaveText("已新增商品。");
}

async function uploadCover(admin: Page, name: string) {
  await admin.getByRole("row", { name: new RegExp(name) }).getByRole("link", { name: "編輯" }).click();
  const png = await admin.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = 400; canvas.height = 300;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#e5d8c5"; context.fillRect(0, 0, 400, 300);
    context.fillStyle = "#174ea6"; context.fillRect(130, 60, 140, 180);
    return canvas.toDataURL("image/png").split(",")[1]!;
  });
  await admin.getByLabel("商品圖片（JPEG、PNG 或 WebP，20 MB 以內）").setInputFiles({ name: "cover.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") });
  await admin.getByRole("button", { name: "上傳商品圖片", exact: true }).click();
  await expect(admin.locator("#image-status")).toContainText("已上傳商品圖片");
}

async function withAdmin(browser: import("@playwright/test").Browser, run: (admin: Page) => Promise<void>) {
  const context = await browser.newContext({ baseURL: BASE_URL, extraHTTPHeaders: adminAccessHeaders() });
  try { await run(await context.newPage()); } finally { await context.close(); }
}

test("管理員建立分類、商品選分類並上架，顧客從導覽列進入分類頁看到該商品", async ({ browser, page }, testInfo) => {
  test.setTimeout(120_000);
  const name = "分類頁測試商品";
  await withAdmin(browser, async (admin) => {
    await createCategory(admin, LIVING);
    await expect(admin.getByRole("status")).toHaveText("已建立分類。");
    const categoryRow = admin.getByRole("row", { name: new RegExp(LIVING.slug) });
    await expect(categoryRow).toContainText(LIVING.name);
    await expect(categoryRow.getByRole("cell", { name: "0", exact: true })).toBeVisible();

    // 代稱已被使用：顯示原因，不新增
    await createCategory(admin, { ...LIVING, name: "重複代稱" });
    await expect(admin.getByRole("alert")).toContainText("這個代稱已被使用");
    // 代稱格式錯誤由 App 驗證；瀏覽器的 pattern 屬性在這裡被繞過，確認顯示原因
    await admin.getByLabel("分類名稱").fill("大寫代稱");
    await admin.getByLabel("分類說明").fill("說明");
    await admin.getByLabel("網址代稱").evaluate((input: HTMLInputElement) => { input.removeAttribute("pattern"); input.value = "Bad Slug"; });
    await admin.getByRole("button", { name: "建立分類" }).click();
    await expect(admin.getByRole("alert")).toContainText("代稱只能使用小寫英文");

    await createProduct(admin, name);
    await assignCategory(admin, name, LIVING.name);
    await uploadCover(admin, name);
    await admin.goto("/admin");
    const productRow = admin.getByRole("row", { name: new RegExp(name) });
    await expect(productRow).toContainText(LIVING.name);
    await productRow.getByRole("button", { name: "重新上架" }).click();
    await expect(productRow).toContainText("上架中");
    await expect(admin.getByRole("row", { name: new RegExp(LIVING.slug) }).getByRole("cell", { name: "1", exact: true })).toBeVisible();
  });

  // 桌機：從主要導覽進入分類頁
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "主要導覽" });
  await nav.getByRole("link", { name: LIVING.name }).click();
  await expect(page).toHaveURL(/\/categories\/e2e-living$/);
  await expect(page.getByRole("heading", { level: 1, name: LIVING.name })).toBeVisible();
  await expect(page.getByText(LIVING.description)).toBeVisible();
  await expect(page.getByText("共 1 件商品")).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: name })).toBeVisible();
  await expect(nav.getByRole("link", { name: LIVING.name })).toHaveAttribute("aria-current", "page");
  await expect(nav.getByRole("link", { name: "全部商品" })).not.toHaveAttribute("aria-current", "page");
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await testInfo.attach("category-desktop", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });

  // 手機：抽屜也列出分類，分類頁沒有橫向捲動且 axe 零違規
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "開啟選單" }).click();
  await page.getByRole("dialog", { name: "選單" }).getByRole("link", { name: LIVING.name }).click();
  await expect(page).toHaveURL(/\/categories\/e2e-living$/);
  await expect(page.getByRole("listitem").filter({ hasText: name })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await testInfo.attach("category-mobile", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
});

test("沒有分類不能上架並顯示原因；沒有上架商品的分類不出現在導覽列，網址回 404", async ({ browser, page }) => {
  test.setTimeout(120_000);
  const name = "未分類測試商品";
  const empty = { slug: "e2e-empty", name: "E2E空分類", description: "沒有任何商品" };
  await withAdmin(browser, async (admin) => {
    await createProduct(admin, name);
    await uploadCover(admin, name);
    await admin.goto("/admin");
    const productRow = admin.getByRole("row", { name: new RegExp(name) });
    await expect(productRow.getByRole("cell", { name: "未分類", exact: true })).toBeVisible();
    await productRow.getByRole("button", { name: "重新上架" }).click();
    await expect(admin.getByRole("alert")).toContainText("請先選擇商品分類");
    await expect(productRow).toContainText("已下架");

    await createCategory(admin, empty);
    await expect(admin.getByRole("status")).toHaveText("已建立分類。");
    // 選好分類之後同一個動作就能成功
    await assignCategory(admin, name, empty.name);
    await admin.getByRole("row", { name: new RegExp(name) }).getByRole("button", { name: "重新上架" }).click();
    await expect(admin.getByRole("row", { name: new RegExp(name) })).toContainText("上架中");
    // 再下架：分類沒有上架商品，前台看不到
    await admin.getByRole("row", { name: new RegExp(name) }).getByRole("button", { name: "下架" }).click();
    await expect(admin.getByRole("row", { name: new RegExp(name) })).toContainText("已下架");
  });

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  await expect(page.getByRole("navigation", { name: "主要導覽" }).getByRole("link", { name: "全部商品" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "主要導覽" }).getByRole("link", { name: empty.name })).toHaveCount(0);
  for (const path of [`/categories/${empty.slug}`, "/categories/no-such-category", "/categories/Bad_Slug"]) {
    const response = await page.goto(path);
    expect(response?.status(), path).toBe(404);
    await expect(page.getByRole("heading", { level: 1, name: "找不到頁面" })).toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations, path).toEqual([]);
  }
});
