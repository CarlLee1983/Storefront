import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { memberSessionCookie } from "../harness/session-cookie";

test.describe("手機選單抽屜", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("開啟後焦點進入 dialog，Esc 關閉並回到選單按鈕", async ({ page }) => {
    await page.goto("/");
    const menuButton = page.getByRole("button", { name: "開啟選單" });
    const dialog = page.getByRole("dialog", { name: "選單" });
    await expect(dialog).toBeHidden();

    await menuButton.focus();
    await page.keyboard.press("Enter");
    await expect(dialog).toBeVisible();
    expect(await page.evaluate(() => document.activeElement?.closest("dialog") !== null)).toBe(true);
    await expect(dialog.getByRole("link", { name: "全部商品" })).toBeVisible();
    await expect(dialog.getByRole("link", { name: "登入" })).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(menuButton).toBeFocused();
  });

  test("關閉按鈕可關閉選單並讓焦點回到選單按鈕", async ({ page }) => {
    await page.goto("/");
    const menuButton = page.getByRole("button", { name: "開啟選單" });
    await menuButton.click();
    await page.getByRole("button", { name: "關閉選單" }).click();
    await expect(page.getByRole("dialog", { name: "選單" })).toBeHidden();
    await expect(menuButton).toBeFocused();
  });

  test("已登入時抽屜有我的訂單與登出，桌機專用的帳號區不可見", async ({ page }) => {
    await page.context().addCookies([memberSessionCookie()]);
    await page.goto("/");
    await page.getByRole("button", { name: "開啟選單" }).click();
    const dialog = page.getByRole("dialog", { name: "選單" });
    await expect(dialog.getByRole("link", { name: "我的訂單" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "登出" })).toBeVisible();
    await expect(page.locator(".site-header .account")).toBeHidden();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  });

  test("打開狀態的選單 axe 零違規", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "開啟選單" }).click();
    await expect(page.getByRole("dialog", { name: "選單" })).toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  });
});

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

test("已登入時桌機 header 看到我的訂單與登出", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.context().addCookies([memberSessionCookie()]);
  await page.goto("/");
  const header = page.locator(".site-header");
  await expect(header.getByRole("link", { name: "我的訂單" })).toBeVisible();
  await expect(header.getByRole("button", { name: "登出" })).toBeVisible();
});

test("Inter 只宣告拉丁 unicode-range，沒有任何網頁字型涵蓋 CJK", async ({ page }) => {
  await page.goto("/");
  const faces = await page.evaluate(async () => {
    await document.fonts.ready;
    return [...document.fonts].map(face => ({ family: face.family, unicodeRange: face.unicodeRange }));
  });
  expect(faces.filter(face => face.family.replaceAll('"', "") === "Inter").length).toBeGreaterThanOrEqual(3);
  const covers = (range: string, codePoint: number) =>
    range.split(",").some(part => {
      const [from, to = from] = part.trim().replace(/^U\+/i, "").split("-").map(hex => Number.parseInt(hex, 16));
      return codePoint >= from! && codePoint <= to!;
    });
  for (const face of faces) {
    expect(covers(face.unicodeRange, 0x4e00), `${face.family} 不可涵蓋 U+4E00`).toBe(false);
  }
  expect(faces.some(face => covers(face.unicodeRange, 0x41))).toBe(true);
});

test("Inter 在 production build 下實際載入成功", async ({ page }) => {
  await page.goto("/");
  const statuses = await page.evaluate(async () => {
    await document.fonts.ready;
    return [...document.fonts].filter(face => face.family.replaceAll('"', "") === "Inter").map(face => face.status);
  });
  expect(statuses).toContain("loaded");
});
