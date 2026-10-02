import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { memberSessionCookie } from "../harness/session-cookie";

async function expectStorefrontHead(page: Page) {
  const title = await page.title();
  expect(title).toContain("靜物");
  const description = await page.locator('meta[name="description"]').getAttribute("content");
  expect(description).toMatch(/\S/);
  const canonical = new URL(new URL(page.url()).pathname, page.url()).href;
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", canonical);
  await expect(page.locator('meta[property="og:url"]')).toHaveAttribute("content", canonical);
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute("content", title);
  await expect(page.locator('meta[name="twitter:title"]')).toHaveAttribute("content", title);
  await expect(page.locator('meta[property="og:description"]')).toHaveAttribute("content", description!);
  await expect(page.locator('meta[name="twitter:description"]')).toHaveAttribute("content", description!);
  const image = await page.locator('meta[property="og:image"]').getAttribute("content");
  expect(new URL(image!).origin).toBe(new URL(page.url()).origin);
  if (new URL(page.url()).pathname !== "/") {
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute("content", new URL("/brand/share.png", page.url()).href);
  }
  await expect(page.locator('meta[name="twitter:image"]')).toHaveAttribute("content", image!);
  await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute("content", "summary_large_image");
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", /\S/);
  await expect(page.locator('link[rel="icon"][type="image\/svg+xml"]')).toHaveAttribute("href", "/brand/favicon.svg");
  await expect(page.locator('link[rel="icon"][type="image\/png"]')).toHaveAttribute("href", "/brand/favicon-32.png");
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute("href", "/brand/apple-touch-icon.png");
}

for (const width of [320, 768, 1280]) {
  test(`前台共用外殼、鍵盤與無障礙（${width}px）`, async ({ page }, testInfo) => {
    // 每種寬度逐頁驗證 15 個路由的 head、鍵盤、axe 與截圖，給整段流程足夠時間。
    test.setTimeout(90_000);
    await page.setViewportSize({ width, height: 900 });
    for (const path of ["/", "/products", "/sale", "/search?q=沒有符合的商品", "/login", "/cart", "/about", "/faq", "/returns", "/not-a-real-page", "/500"]) {
      const response = await page.goto(path);
      expect(response?.status()).toBe(path === "/not-a-real-page" ? 404 : path === "/500" ? 500 : 200);
      await expectStorefrontHead(page);
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
    await page.evaluate(() => localStorage.setItem("storefront.cart", JSON.stringify({ version: 2, lines: [{ variantId: 1, productId: 1, name: "測試商品很長的名稱 ABCDEFGHIJKLMNOPQRSTUVWXYZ", unitPriceTwd: 1200, quantity: 1 }] })));
    for (const path of ["/cart", "/checkout", "/orders", "/orders/999999999"]) {
      await page.goto(path);
      await expectStorefrontHead(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await testInfo.attach(`${width}-${path.replaceAll("/", "_") || "home"}`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
    }
  });
}

// 故事 60、73：頁尾有店名、介紹、導覽與示範聲明，深色底
test("頁尾：店名、介紹、頁尾導覽連結與深色底", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  const footer = page.getByRole("contentinfo");
  await expect(footer).toContainText("靜物 / Still Life");
  await expect(footer).toContainText("為日常挑選的家具與器物。");
  const nav = footer.getByRole("navigation", { name: "頁尾導覽" });
  for (const [name, href] of [["全部商品", "/products"], ["我的訂單", "/orders"]] as const) {
    await expect(nav.getByRole("link", { name })).toHaveAttribute("href", href);
  }
  await expect(nav.getByRole("link", { name: "關於" })).toHaveAttribute("href", "/about");
  await expect(nav.getByRole("link", { name: "常見問題" })).toHaveAttribute("href", "/faq");
  await expect(nav.getByRole("link", { name: "退換貨說明" })).toHaveAttribute("href", "/returns");
  await expect(footer.getByRole("link", { name: "hello@gravito.dev" })).toHaveAttribute("href", "mailto:hello@gravito.dev");
  await expect(footer).toContainText(`© ${new Date().getFullYear()} 靜物 Still Life`);
  await expect(footer).toContainText("示範網站，不實際出貨");
  for (const [path, type] of [["/brand/favicon.svg", "image/svg+xml"], ["/brand/favicon-32.png", "image/png"], ["/brand/apple-touch-icon.png", "image/png"], ["/brand/share.png", "image/png"]]) {
    const response = await page.request.get(path!);
    expect(response.status(), path).toBe(200);
    expect(response.headers()["content-type"]).toContain(type);
  }
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
