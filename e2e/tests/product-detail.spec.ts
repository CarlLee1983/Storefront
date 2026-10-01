import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { adminAccessHeaders } from "../harness/admin-access";
import { assignSharedCategory } from "../harness/admin-categories";
import { BASE_URL } from "../harness/constants";

async function createGallery(admin: Page, name: string) {
  await admin.goto("/admin");
  await admin.getByLabel("名稱", { exact: true }).fill(name);
  await admin.getByLabel("說明", { exact: true }).fill("為日常挑選的手工花器。\n每件作品都有不同的紋理與溫度。");
  await admin.getByLabel("單價（新台幣整數元）").fill("680");
  await admin.getByRole("button", { name: "新增商品", exact: true }).click();
  await assignSharedCategory(admin, name);
  await admin.getByRole("row").filter({ hasText: name }).getByRole("link", { name: "編輯" }).click();
  const id = new URL(admin.url()).pathname.split("/").pop()!;
  const pngs = await admin.evaluate(() => ["#164e63", "#9f1239", "#3f6212"].map((color, index) => {
    const canvas = document.createElement("canvas"); canvas.width = 800; canvas.height = 600;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#eee7dc"; ctx.fillRect(0, 0, 800, 600);
    ctx.fillStyle = color; ctx.beginPath(); ctx.ellipse(400, 340, 130 + 20 * index, 190, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#eee7dc"; ctx.fillRect(260, 130, 280, 45);
    return canvas.toDataURL("image/png").split(",")[1]!;
  }));
  await admin.getByLabel("商品圖片（JPEG、PNG 或 WebP，20 MB 以內）").setInputFiles(pngs.map((png, index) => ({ name: `vase-${index}.png`, mimeType: "image/png", buffer: Buffer.from(png, "base64") })));
  await admin.getByRole("button", { name: "上傳商品圖片", exact: true }).click();
  await expect(admin.locator("#product-images li")).toHaveCount(3);
  await expect(admin.locator("#image-status")).toContainText("已上傳商品圖片");
  await admin.getByRole("button", { name: "上移商品圖片 2", exact: true }).click();
  await expect(admin.locator("#image-status")).toContainText("已儲存商品圖片順序");
  const coverSrc = await admin.locator("#product-images img").first().getAttribute("src");
  await admin.goto("/admin");
  const row = admin.getByRole("row").filter({ hasText: name });
  await row.getByRole("button", { name: "重新上架", exact: true }).click();
  await expect(row).toContainText("上架中");
  return { id, coverSrc };
}

test("public detail gallery, keyboard and swipe, shared cart feedback, sold-out and real 404", async ({ browser, page }, testInfo) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({ baseURL: BASE_URL, extraHTTPHeaders: adminAccessHeaders() });
  const admin = await context.newPage();
  const name = "詳情頁手工花器";
  try {
    const { id, coverSrc } = await createGallery(admin, name);
    const detailPath = `/products/${id}`;
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await page.getByRole("link").filter({ has: page.getByRole("heading", { name, exact: true }) }).click();
    await expect(page).toHaveURL(new RegExp(`${detailPath}$`));
    await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
    await expect(page.getByText("已售完", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "加入購物車" })).toHaveCount(0);
    await expect(page.locator(".gallery-slide img").first()).toHaveAttribute("src", coverSrc!);
    await expect(page.locator(".gallery-slide img").first()).toHaveAttribute("srcset", /320w.*640w.*1280w/);
    await expect.poll(() => page.locator(".gallery-slide img").first().evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
    const track = page.getByRole("group", { name: "商品圖片瀏覽", exact: true });
    const thumbs = page.getByRole("group", { name: "選擇商品圖片", exact: true }).getByRole("button");
    await track.focus();
    await page.keyboard.press("ArrowRight");
    await expect(thumbs.nth(1)).toHaveAttribute("aria-current", "true");
    await page.keyboard.press("End");
    await expect(thumbs.nth(2)).toHaveAttribute("aria-current", "true");
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "上一張商品圖片", exact: true })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(thumbs.nth(1)).toHaveAttribute("aria-current", "true");
    await thumbs.first().focus();
    await page.keyboard.press("ArrowRight");
    await expect(thumbs.nth(1)).toBeFocused();
    await page.keyboard.press("Home");
    await expect(thumbs.first()).toBeFocused();
    await page.keyboard.press("Enter");
    // Touch input exercises native horizontal scrolling and CSS scroll-snap.
    const box = (await track.boundingBox())!;
    const session = await page.context().newCDPSession(page);
    const y = box.y + box.height / 2;
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box.x + box.width - 30, y }] });
    for (let n = 1; n <= 6; n++) await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: box.x + box.width - 30 - (box.width - 60) * n / 6, y }] });
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await session.detach();
    await expect(thumbs.first()).not.toHaveAttribute("aria-current", "true");
    await thumbs.nth(1).click();
    await expect(thumbs.nth(1)).toHaveAttribute("aria-current", "true");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await expect(page.locator(".gallery-position")).toHaveText("2 / 3");
    await expect.poll(() => page.locator(".gallery-slide").nth(1).evaluate(slide =>
      Math.abs(slide.getBoundingClientRect().left - slide.parentElement!.getBoundingClientRect().left))).toBeLessThan(2);
    await expect(page.locator("[data-gallery-index][aria-current=\"true\"]")).toHaveCount(1);
    await testInfo.attach("product-detail-mobile", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
    const row = admin.getByRole("row").filter({ hasText: name });
    await row.getByLabel(`${name}的庫存增減量`).fill("10");
    await row.getByRole("button", { name: "調整庫存" }).click();
    await page.reload();
    await page.getByLabel("數量", { exact: true }).fill("2");
    const add = page.getByRole("button", { name: "加入購物車", exact: true });
    await add.focus(); await page.keyboard.press("Enter");
    await expect(page.locator(".cart-status")).toHaveText("已加入購物車（目前 2 件）");
    await expect(add).toBeFocused();
    await expect(page.locator("#cart-count")).toHaveText("2");
    await expect(page.locator("#cart-count")).toHaveClass("count-bump");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.keyboard.press("Enter");
    await expect(page.locator(".cart-status")).toHaveText("已加入購物車（目前 4 件）");
    expect(await page.locator(".cart-status").evaluate(el => getComputedStyle(el).animationName)).toBe("none");
    await page.setViewportSize({ width: 1440, height: 1000 });
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await testInfo.attach("product-detail-desktop-toast", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
    await page.getByRole("link", { name: /購物車（\s*4\s*）/ }).click();
    await expect(page.getByRole("img", { name: `${name}的封面`, exact: true })).toHaveAttribute("src", coverSrc!);
    await page.goBack();
    await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
    await row.getByRole("button", { name: "下架", exact: true }).click();
    await expect(row).toContainText("下架");
    for (const path of [detailPath, "/products/999999", "/products/not-a-number"]) {
      expect((await page.goto(path))!.status()).toBe(404);
      await expect(page.getByRole("heading", { name: "找不到頁面" })).toBeVisible();
      await expect(page.getByRole("button", { name: "加入購物車" })).toHaveCount(0);
    }
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  } finally { await context.close(); }
});
