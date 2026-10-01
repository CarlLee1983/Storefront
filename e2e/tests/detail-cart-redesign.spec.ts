import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { adminAccessHeaders } from "../harness/admin-access";
import { assignCategory, createCategory } from "../harness/admin-categories";
import { BASE_URL } from "../harness/constants";

const CATEGORY = { slug: "e2e-detail", name: "詳情分類", description: "詳情頁與購物車改版測試用的分類" };
const MAIN = { name: "改版主打花器", priceTwd: 680 };
const OTHER = { name: "改版同類托盤", priceTwd: 480 };

async function createListedProduct(admin: Page, name: string, priceTwd: number) {
  await admin.goto("/admin");
  await admin.getByLabel("名稱", { exact: true }).fill(name);
  await admin.getByLabel("說明", { exact: true }).fill("為日常挑選的好物，簡單而耐用。");
  await admin.getByLabel("單價（新台幣整數元）").fill(String(priceTwd));
  await admin.getByRole("button", { name: "新增商品" }).click();
  await expect(admin.getByRole("status")).toHaveText("已新增商品。");
  await assignCategory(admin, name, CATEGORY.name);
  const row = admin.getByRole("row", { name: new RegExp(name) });
  await row.getByLabel(`${name}的庫存增減量`).fill("10");
  await row.getByRole("button", { name: "調整庫存" }).click();
  await expect(admin.getByRole("status")).toHaveText("已調整庫存。");
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
  await row.getByRole("button", { name: "重新上架" }).click();
  await expect(row).toContainText("上架中");
}

const noHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
const noAxeViolations = async (page: Page) => expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  const context = await browser.newContext({ baseURL: BASE_URL, extraHTTPHeaders: adminAccessHeaders() });
  try {
    const admin = await context.newPage();
    await createCategory(admin, CATEGORY);
    await expect(admin.getByRole("status")).toHaveText("已建立分類。");
    await createListedProduct(admin, MAIN.name, MAIN.priceTwd);
    await createListedProduct(admin, OTHER.name, OTHER.priceTwd);
  } finally { await context.close(); }
});

async function openMainDetail(page: Page) {
  await page.goto(`/categories/${CATEGORY.slug}`);
  await page.getByRole("link").filter({ has: page.getByRole("heading", { name: MAIN.name, exact: true }) }).click();
  await expect(page).toHaveURL(/\/products\/\d+$/);
}

test("詳情頁：麵包屑、鍵盤調數量並加入購物車、同分類推薦可進入，桌機與手機 axe 零違規", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openMainDetail(page);

  const crumbs = page.getByRole("navigation", { name: "麵包屑" });
  await expect(crumbs.getByRole("link", { name: "全部商品" })).toHaveAttribute("href", "/products");
  await expect(crumbs.getByRole("link", { name: CATEGORY.name })).toHaveAttribute("href", `/categories/${CATEGORY.slug}`);
  await expect(crumbs.getByText(MAIN.name)).toHaveAttribute("aria-current", "page");

  const information = page.getByRole("region", { name: "商品資訊" });
  await expect(information.getByRole("heading", { level: 1, name: MAIN.name })).toBeVisible();
  await expect(information).toContainText(CATEGORY.name);
  await expect(information).toContainText("NT$ 680");
  await expect(information).toContainText("含稅、免運。付款後無法自行取消，商品問題請聯繫客服。");

  // 鍵盤：焦點在「增加數量」按鈕上按 Enter 加一、在「減少數量」上按空白鍵減一，再 Tab 到加入購物車
  const quantity = information.getByLabel("數量", { exact: true });
  const increase = information.getByRole("button", { name: "增加數量" });
  await increase.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await expect(quantity).toHaveValue("3");
  await information.getByRole("button", { name: "減少數量" }).focus();
  await page.keyboard.press("Space");
  await expect(quantity).toHaveValue("2");
  await quantity.fill("99");
  await increase.focus();
  await page.keyboard.press("Enter");
  await expect(quantity).toHaveValue("99");
  await quantity.fill("2");
  await increase.focus();
  await page.keyboard.press("Tab");
  const add = information.getByRole("button", { name: "加入購物車", exact: true });
  await expect(add).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(information.getByRole("status")).toHaveText("已加入購物車（目前 2 件）");
  await expect(page.locator("#cart-count")).toHaveText("2");

  await noAxeViolations(page);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await noHorizontalScroll(page)).toBe(true);
  await noAxeViolations(page);
  await page.setViewportSize({ width: 1280, height: 900 });

  // 同分類推薦：只有另一件商品，不含自己，可點進去
  const related = page.getByRole("region", { name: "同分類的其他商品" });
  await expect(related.getByRole("listitem")).toHaveCount(1);
  await expect(related).toContainText(OTHER.name);
  await expect(related).not.toContainText(MAIN.name);
  await related.getByRole("link").filter({ has: page.getByRole("heading", { name: OTHER.name, exact: true }) }).click();
  await expect(page.getByRole("region", { name: "商品資訊" }).getByRole("heading", { level: 1, name: OTHER.name })).toBeVisible();
  await expect(page.getByRole("region", { name: "同分類的其他商品" })).toContainText(MAIN.name);
});

test("購物車：320／768／1280 px 都不需橫向捲動、數量加減與移除正常，axe 零違規", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openMainDetail(page);
  const information = page.getByRole("region", { name: "商品資訊" });
  await information.getByLabel("數量", { exact: true }).fill("2");
  await information.getByRole("button", { name: "加入購物車", exact: true }).click();
  await expect(page.locator("#cart-count")).toHaveText("2");

  await page.goto("/cart");
  await expect(page.getByRole("heading", { level: 1, name: "購物車" })).toBeVisible();
  const line = page.getByRole("listitem").filter({ hasText: MAIN.name });
  await expect(line.getByRole("img", { name: `${MAIN.name}的封面` })).toBeVisible();
  await expect(line).toContainText("單價 NT$ 680");
  await expect(page.locator("#cart-total")).toHaveText("1,360");
  const summary = page.getByRole("complementary").filter({ hasText: "訂單摘要" });
  await expect(summary).toContainText("免運");
  await expect(summary).toContainText("單價為加入購物車當時所見的價格；結帳時若價格已變動，會先請你確認。");
  await expect(summary.getByRole("link", { name: "前往結帳" })).toHaveAttribute("href", "/checkout");

  for (const width of [320, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await noHorizontalScroll(page), `${width}px 不應有水平捲動`).toBe(true);
    await noAxeViolations(page);
  }

  const quantity = line.getByLabel(`${MAIN.name} 數量`);
  await line.getByRole("button", { name: `增加${MAIN.name}數量` }).click();
  await expect(quantity).toHaveValue("3");
  await expect(line.getByRole("button", { name: `增加${MAIN.name}數量` })).toBeFocused();
  await expect(page.locator("#cart-total")).toHaveText("2,040");
  await expect(page.locator("#cart-count")).toHaveText("3");
  await line.getByRole("button", { name: `減少${MAIN.name}數量` }).click();
  await expect(quantity).toHaveValue("2");
  await expect(page.locator("#cart-total")).toHaveText("1,360");
  await line.getByRole("button", { name: "移除" }).click();
  await expect(page.getByText("購物車是空的。")).toBeVisible();
  await expect(page.locator("#cart-count")).toHaveText("0");
  await noAxeViolations(page);
});
