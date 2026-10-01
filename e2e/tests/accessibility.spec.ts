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
