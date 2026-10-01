import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { memberSessionCookie } from "../harness/session-cookie";

for (const width of [320, 768, 1280]) {
  test(`前台共用外殼、鍵盤與無障礙（${width}px）`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    for (const path of ["/", "/login", "/cart", "/about", "/faq", "/returns", "/not-a-real-page", "/500"]) {
      const response = await page.goto(path);
      expect(response?.status()).toBe(path === "/not-a-real-page" ? 404 : path === "/500" ? 500 : 200);
      await expect(page.getByRole("navigation", { name: "頁尾導覽" })).toBeVisible();
      await page.keyboard.press("Tab");
      await expect(page.getByRole("link", { name: "跳到主要內容" })).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page.locator("#main-content")).toBeFocused();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await testInfo.attach(`${width}-${path.replaceAll("/", "_") || "home"}`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
    }
    await page.context().addCookies([memberSessionCookie()]);
    await page.goto("/cart");
    await page.evaluate(() => localStorage.setItem("storefront.cart", JSON.stringify({ version: 1, lines: [{ productId: 1, name: "測試商品很長的名稱 ABCDEFGHIJKLMNOPQRSTUVWXYZ", unitPriceTwd: 1200, quantity: 1 }] })));
    for (const path of ["/cart", "/checkout", "/orders", "/orders/999999999"]) {
      await page.goto(path);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await testInfo.attach(`${width}-${path.replaceAll("/", "_") || "home"}`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
    }
  });
}

// 故事 60：頁尾有店名、一句介紹與頁尾導覽，深色底
test("頁尾：店名、介紹、頁尾導覽連結與深色底", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  const footer = page.getByRole("contentinfo");
  await expect(footer).toContainText("Storefront");
  await expect(footer).toContainText("為日常挑選的家具與器物。");
  const nav = footer.getByRole("navigation", { name: "頁尾導覽" });
  await expect(nav.getByRole("link", { name: "關於" })).toHaveAttribute("href", "/about");
  await expect(nav.getByRole("link", { name: "常見問題" })).toHaveAttribute("href", "/faq");
  await expect(nav.getByRole("link", { name: "退換貨說明" })).toHaveAttribute("href", "/returns");
  // 背景必須不透明：透明的 rgba(0, 0, 0, 0) 算出來亮度是 0，會誤判成深色
  const alpha = await footer.evaluate((element) => {
    const channels = getComputedStyle(element).backgroundColor.match(/[\d.]+/g)!.map(Number);
    return channels.length > 3 ? channels[3]! : 1;
  });
  expect(alpha).toBe(1);
  // 背景色的相對亮度（WCAG 公式）要低於 0.2 才算深色
  const luminance = await footer.evaluate((element) => {
    const [r, g, b] = getComputedStyle(element).backgroundColor.match(/[\d.]+/g)!.slice(0, 3).map(Number).map((value) => {
      const channel = value / 255;
      return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  });
  expect(luminance).toBeLessThan(0.2);
});
