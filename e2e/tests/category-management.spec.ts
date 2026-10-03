import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { adminAccessHeaders } from "../harness/admin-access";
import { assignCategory, createCategory } from "../harness/admin-categories";
import { BASE_URL } from "../harness/constants";
import { gotoProductList } from "../harness/admin-list";

const MANAGED = { slug: "e2e-managed", name: "E2E管理分類", description: "建立時的說明" };
const THROWAWAY = { slug: "e2e-throwaway", name: "E2E暫時分類", description: "建錯的分類" };
const NEW_DESCRIPTION = "修改後的一行說明";

async function pngFile(page: Page, color: string, name: string) {
  const png = await page.evaluate((fill) => {
    const canvas = document.createElement("canvas"); canvas.width = 400; canvas.height = 300;
    const context = canvas.getContext("2d")!;
    context.fillStyle = fill; context.fillRect(0, 0, 400, 300);
    context.fillStyle = "#ffffff"; context.fillRect(130, 60, 140, 180);
    return canvas.toDataURL("image/png").split(",")[1]!;
  }, color);
  return { name, mimeType: "image/png", buffer: Buffer.from(png, "base64") };
}

async function createListedProduct(admin: Page, name: string, categoryName: string) {
  await admin.goto("/admin/products/new");
  await admin.getByLabel("名稱", { exact: true }).fill(name);
  await admin.getByLabel("單價（新台幣整數元）").fill("880");
  await admin.getByRole("button", { name: "新增商品", exact: true }).click();
  await expect(admin.getByRole("status").filter({ hasText: "已新增商品。" })).toHaveText("已新增商品。");
  await assignCategory(admin, name, categoryName);
  await admin.getByRole("row", { name: new RegExp(name) }).getByRole("link", { name: "編輯" }).click();
  await admin.getByLabel("商品圖片（JPEG、PNG 或 WebP，20 MB 以內）").setInputFiles(await pngFile(admin, "#e5d8c5", "cover.png"));
  await admin.getByRole("button", { name: "上傳商品圖片", exact: true }).click();
  await expect(admin.locator("#image-status")).toContainText("已上傳商品圖片");
  await gotoProductList(admin, name);
  const row = admin.getByRole("row", { name: new RegExp(name) });
  await row.getByRole("button", { name: "重新上架" }).click();
  await expect(row).toContainText("上架中");
}

test("管理員修改分類說明、上傳並更換分類圖片、刪除空分類；有商品的分類刪除被拒並顯示原因；手機抽屜顯示說明", async ({ browser, page }, testInfo) => {
  test.setTimeout(150_000);
  const context = await browser.newContext({ baseURL: BASE_URL, extraHTTPHeaders: adminAccessHeaders() });
  const admin = await context.newPage();
  admin.on("dialog", (dialog) => void dialog.accept());
  const productName = "分類管理測試商品";
  try {
    await createCategory(admin, MANAGED);
    await expect(admin.getByRole("status")).toHaveText("已建立分類。");

    // 清單：商品數與上架商品數
    await admin.goto("/admin/categories");
    const row = admin.getByRole("row", { name: new RegExp(MANAGED.slug) });
    await expect(row.getByRole("cell", { name: "0", exact: true })).toHaveCount(2);
    await expect(row.getByText("尚無圖片")).toBeVisible();

    // 修改說明；代稱只顯示、沒有輸入框
    await row.getByRole("link", { name: /修改/ }).click();
    await expect(admin.getByText(MANAGED.slug)).toBeVisible();
    await expect(admin.getByLabel("網址代稱")).toHaveCount(0);
    await admin.getByLabel("分類說明").fill(NEW_DESCRIPTION);
    await admin.getByRole("button", { name: "儲存" }).click();
    await expect(admin.getByRole("status")).toHaveText("已儲存分類。");
    await expect(admin.getByRole("row", { name: new RegExp(MANAGED.slug) })).toContainText(NEW_DESCRIPTION);

    // 上傳圖片，再更換
    await admin.getByRole("row", { name: new RegExp(MANAGED.slug) }).getByRole("link", { name: /修改/ }).click();
    const image = admin.locator("#category-image");
    await expect(image).toBeHidden();
    await admin.getByLabel("分類圖片（JPEG、PNG 或 WebP，20 MB 以內）").setInputFiles(await pngFile(admin, "#174ea6", "first.png"));
    await admin.getByRole("button", { name: "上傳分類圖片", exact: true }).click();
    await expect(admin.locator("#image-status")).toHaveText("已儲存分類圖片。");
    await expect(image).toBeVisible();
    const first = await image.getAttribute("src");
    expect(first).toMatch(/^\/images\/categories\/\d+\/[0-9a-f-]{36}\/[0-9a-f]{64}\.webp$/);
    expect((await admin.request.get(first!)).status()).toBe(200);
    await admin.getByLabel("分類圖片（JPEG、PNG 或 WebP，20 MB 以內）").setInputFiles(await pngFile(admin, "#9f1239", "second.png"));
    await admin.getByRole("button", { name: "上傳分類圖片", exact: true }).click();
    await expect(image).not.toHaveAttribute("src", first!);
    await expect(admin.locator("#image-status")).toHaveText("已儲存分類圖片。");
    expect((await new AxeBuilder({ page: admin }).analyze()).violations).toEqual([]);
    await admin.reload();
    const second = await image.getAttribute("src");
    expect(second).not.toBe(first);
    expect((await admin.request.get(first!)).status()).toBe(404);

    // 商品歸到這個分類並上架：清單顯示 1 / 1，刪除被拒並顯示原因
    await createListedProduct(admin, productName, MANAGED.name);
    await admin.goto("/admin/categories");
    const managedRow = admin.getByRole("row", { name: new RegExp(MANAGED.slug) });
    await expect(managedRow.getByRole("cell", { name: "1", exact: true })).toHaveCount(2);
    await expect(managedRow.getByRole("img", { name: `${MANAGED.name}的分類圖片` })).toHaveAttribute("src", second!);
    await managedRow.getByRole("button", { name: `刪除${MANAGED.name}` }).click();
    await expect(admin.getByRole("alert")).toContainText(`無法刪除「${MANAGED.name}」`);
    await expect(admin.getByRole("alert")).toContainText("還有商品");
    await expect(admin.getByRole("row", { name: new RegExp(MANAGED.slug) })).toBeVisible();
    expect((await new AxeBuilder({ page: admin }).analyze()).violations).toEqual([]);
    await testInfo.attach("admin-categories", { body: await admin.screenshot({ fullPage: true }), contentType: "image/png" });

    // 空分類可以刪除
    await createCategory(admin, THROWAWAY);
    await expect(admin.getByRole("status")).toHaveText("已建立分類。");
    await admin.goto("/admin/categories");
    await admin.getByRole("row", { name: new RegExp(THROWAWAY.slug) }).getByRole("button", { name: `刪除${THROWAWAY.name}` }).click();
    await expect(admin.getByRole("status")).toHaveText("已刪除分類。");
    await expect(admin.getByRole("row", { name: new RegExp(THROWAWAY.slug) })).toHaveCount(0);
  } finally {
    await context.close();
  }

  // 手機抽屜：分類名稱下方有說明；桌機導覽列只有名稱
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "開啟選單" }).click();
  const drawer = page.getByRole("dialog", { name: "選單" });
  await expect(drawer.getByRole("link", { name: MANAGED.name })).toContainText(NEW_DESCRIPTION);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  await expect(page.getByRole("navigation", { name: "主要導覽" }).getByRole("link", { name: MANAGED.name })).not.toContainText(NEW_DESCRIPTION);
});
