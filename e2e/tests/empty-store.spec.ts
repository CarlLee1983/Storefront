import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { adminAccessHeaders } from "../harness/admin-access";
import { BASE_URL } from "../harness/constants";

// 這支 spec 在獨立的 empty-store project 裡、最先執行（見 playwright.config.ts）：
// 此時店裡還沒有任何上架商品，首頁要隱藏精選區與分類方塊，導覽列也不出現特價入口（故事 46）。

test("店裡沒有上架商品時，首頁不出現精選區、分類方塊與特價入口，axe 零違規", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  await expect(page.getByRole("region", { name: "精選商品" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "依空間選物" })).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "主要導覽" }).getByRole("link", { name: "特價" })).toHaveCount(0);
  await expect(page.locator('a[href^="/categories/"]')).toHaveCount(0);
  const heroLinks = page.getByRole("region", { name: "主視覺" }).locator("a.button-link");
  await expect(heroLinks).toHaveCount(3);
  for (const link of await heroLinks.all()) {
    await expect(link).toHaveAttribute("href", "/products");
    await expect(link).toHaveText("全部商品");
  }
  expect((await new AxeBuilder({ page }).analyze()).violations, "空店面首頁").toEqual([]);
});

// 桌機 header 的單排版面只在沒有分類的乾淨狀態下有意義：分類是全域狀態、由其他 spec 並行建立，
// 分類一多導覽列本來就會換行（版面允許），放在一般 project 裡會隨執行順序時過時不過。
test("桌機 header 為一排主要導覽，含全部商品與購物車件數", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "主要導覽" });
  await expect(nav.getByRole("link", { name: "全部商品" })).toBeVisible();
  await expect(page.locator("#cart-count")).toBeVisible();
  await expect(page.getByRole("button", { name: "開啟選單" })).toBeHidden();
  const tops = await page.locator(".site-header a:visible, .site-header #cart-count:visible").evaluateAll(elements => elements.map(element => Math.round(element.getBoundingClientRect().top)));
  expect(Math.max(...tops) - Math.min(...tops)).toBeLessThan(24);
});

for (const width of [375, 1280]) {
  test(`空分類管理頁仍可建立分類（${width}px）`, async ({ browser }) => {
    const context = await browser.newContext({ baseURL: BASE_URL, extraHTTPHeaders: adminAccessHeaders(), viewport: { width, height: 900 } });
    try {
      const page = await context.newPage();
      expect((await page.goto("/admin/categories"))?.status()).toBe(200);
      await expect(page.getByText("目前沒有分類。")).toBeVisible();
      await expect(page.getByRole("region", { name: "分類資料表" })).toHaveCount(0);
      await expect(page.getByLabel("分類名稱")).toBeEditable();
      await expect(page.getByLabel("分類說明")).toBeEditable();
      await expect(page.getByLabel("網址代稱")).toBeEditable();
      await expect(page.getByRole("button", { name: "建立分類" })).toBeEnabled();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    } finally {
      await context.close();
    }
  });
}
