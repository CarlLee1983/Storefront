import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

// 這支 spec 在獨立的 empty-store project 裡、最先執行（見 playwright.config.ts）：
// 此時店裡還沒有任何上架商品，首頁要隱藏精選區與分類方塊，導覽列也不出現特價入口（故事 46）。

test("店裡沒有上架商品時，首頁不出現精選區、分類方塊與特價入口，axe 零違規", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  await expect(page.getByRole("region", { name: "精選商品" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "選購分類" })).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "主要導覽" }).getByRole("link", { name: "特價" })).toHaveCount(0);
  expect((await new AxeBuilder({ page }).analyze()).violations, "空店面首頁").toEqual([]);
});
