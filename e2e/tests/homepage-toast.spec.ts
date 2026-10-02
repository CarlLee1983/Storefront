import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { adminAccessHeaders } from "../harness/admin-access";
import { assignSharedCategory } from "../harness/admin-categories";
import { expectFeaturedWithinBudget, featureProduct } from "../harness/admin-featured";
import { BASE_URL } from "../harness/constants";

async function createProduct(admin: Page, name: string, stock: number) {
  await admin.goto("/admin/products/new");
  await admin.getByLabel("名稱", { exact: true }).fill(name);
  await admin.getByLabel("說明", { exact: true }).fill("為日常挑選的好物，簡單而耐用。");
  await admin.getByLabel("單價（新台幣整數元）").fill("680");
  await admin.getByRole("button", { name: "新增商品" }).click();
  await expect(admin.getByRole("status").filter({ hasText: "已新增商品。" })).toHaveText("已新增商品。");
  await assignSharedCategory(admin, name);
  let row = admin.getByRole("row", { name: new RegExp(name) });
  if (stock) {
    await row.getByLabel(`${name}的庫存增減量`).fill(String(stock));
    await row.getByRole("button", { name: "調整庫存" }).click();
    await expect(admin.getByRole("status")).toHaveText("已調整庫存。");
  }
  await row.getByRole("link", { name: "編輯" }).click();
  const png = await admin.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = 400; canvas.height = 300;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#e5d8c5"; context.fillRect(0, 0, 400, 300);
    context.fillStyle = "#174ea6"; context.fillRect(130, 60, 140, 180);
    return canvas.toDataURL("image/png").split(",")[1]!;
  });
  await admin.getByLabel("商品圖片（JPEG、PNG 或 WebP，20 MB 以內）").setInputFiles({ name: "cover.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") });
  await admin.getByRole("button", { name: "上傳商品圖片" }).click();
  await expect(admin.locator("#image-status")).toContainText("已上傳商品圖片");
  await admin.goto("/admin");
  row = admin.getByRole("row", { name: new RegExp(name) });
  await row.getByRole("button", { name: "重新上架" }).click();
  await expect(row).toContainText("上架中");
  // 首頁只放 4 件精選：標為精選才保證商品出現在首頁（與 homepage.spec.ts 合計只標 4 件，見該檔說明）
  await featureProduct(admin, name);
}

test("首頁卡片、售完狀態、可重複 toast、件數及減少動態效果", async ({ browser, page }, testInfo) => {
  test.setTimeout(90_000);
  expectFeaturedWithinBudget("toast", 2);
  const adminContext = await browser.newContext({ baseURL: BASE_URL, extraHTTPHeaders: adminAccessHeaders() });
  try {
    const admin = await adminContext.newPage();
    await createProduct(admin, "首頁選物測試", 5);
    await createProduct(admin, "首頁售完測試", 0);
  } finally { await adminContext.close(); }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const card = page.getByRole("listitem").filter({ hasText: "首頁選物測試" });
  const sold = page.getByRole("listitem").filter({ hasText: "首頁售完測試" });
  await expect(sold).toContainText("已售完");
  await expect(sold.getByRole("button", { name: "加入購物車" })).toHaveCount(0);
  await expect(card.locator("img")).toHaveAttribute("srcset", /320w.*640w.*1280w/);
  await card.getByRole("button", { name: "加入購物車" }).focus();
  await page.keyboard.press("Enter");
  await expect(card.getByRole("status")).toHaveText("已加入購物車，目前 1 件。");
  // Entry motion must never fade the live-region text below its AA contrast.
  expect(await card.getByRole("status").evaluate(element => getComputedStyle(element).opacity)).toBe("1");
  await expect(card.getByRole("button", { name: "加入購物車" })).toBeFocused();
  await expect(page.locator("#cart-count")).toHaveText("1");
  await expect(page.locator("#cart-count")).toHaveClass("count-bump");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await testInfo.attach("homepage-mobile-toast", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.keyboard.press("Enter");
  await expect(card.getByRole("status")).toHaveText("已加入購物車，目前 2 件。");
  await expect(page.locator("#cart-count")).toHaveText("2");
  expect(await card.getByRole("status").evaluate(element => getComputedStyle(element).animationName)).toBe("none");
  expect(await page.locator("#cart-count").evaluate(element => getComputedStyle(element).animationName)).toBe("none");
  await expect(card.getByRole("status")).toBeEmpty({ timeout: 7000 });
  await page.setViewportSize({ width: 1440, height: 1000 });
  expect(await page.locator(".product-list").evaluate(element => getComputedStyle(element).gridTemplateColumns.split(" ").length)).toBe(4);
  await testInfo.attach("homepage-desktop", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
});
