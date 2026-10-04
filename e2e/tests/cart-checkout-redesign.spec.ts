import { expect, test, type Page } from "@playwright/test";
import { adminAccessHeaders } from "../harness/admin-access";
import { assignSharedCategory } from "../harness/admin-categories";
import { BASE_URL } from "../harness/constants";
import { memberSessionCookie } from "../harness/session-cookie";
import { gotoProductList } from "../harness/admin-list";
import { analyzeWhenSettled } from "../harness/axe";

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
    await row.getByLabel(`${name}的庫存調整原因`).fill("E2E 補貨");
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
  await gotoProductList(admin, name);
  row = admin.getByRole("row", { name: new RegExp(name) });
  await row.getByRole("button", { name: "重新上架" }).click();
  await expect(row).toContainText("上架中");
}


test("購物車封面快照、手機卡片、數量、結帳錯誤關聯與圖片失效仍能結帳", async ({ browser, page }, testInfo) => {
  test.setTimeout(90_000);
  const name = "購物車封面測試";
  const adminContext = await browser.newContext({ baseURL: BASE_URL, extraHTTPHeaders: adminAccessHeaders() });
  try { await createProduct(await adminContext.newPage(), name, 10); }
  finally { await adminContext.close(); }
  await page.context().addCookies([memberSessionCookie()]);
  await page.goto("/products");
  const product = page.getByRole("listitem").filter({ hasText: name });
  const source = await product.getByAltText(name, { exact: true }).getAttribute("src");
  await product.getByRole("button", { name: "加入購物車" }).click();
  await expect(page.locator("#cart-count")).toHaveText("1");
  await page.goto("/cart");
  const row = page.getByRole("listitem").filter({ hasText: name });
  await expect(row.getByRole("img")).toHaveAttribute("src", source!);
  await row.getByLabel(`${name} 數量`).fill("2");
  await row.getByLabel(`${name} 數量`).press("Tab");
  await expect(row.getByRole("button", { name: `增加${name}數量` })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(row.getByRole("button", { name: "移除" })).toBeFocused();
  await expect(page.locator("#cart-total")).toHaveText("1,360");
  await page.reload();
  await expect(row.getByLabel(`${name} 數量`)).toHaveValue("2");
  await expect(row.getByRole("img")).toHaveAttribute("src", source!);
  const cartTitleHeights = new Map<number, number>();
  for (const width of [320, 375, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    cartTitleHeights.set(width, (await page.getByRole("heading", { level: 1, name: "購物車" }).boundingBox())!.height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect((await analyzeWhenSettled(page)).violations).toEqual([]);
    await testInfo.attach(`cart-${width}`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
  }
  await page.route("**/images/**", route => route.fulfill({ status: 404 }));
  await page.reload();
  await expect(row.getByText("暫無商品圖片")).toBeVisible();
  await expect(row.getByRole("img")).toHaveCount(0);
  await page.getByRole("link", { name: "前往結帳" }).click();
  await expect(page.getByRole("heading", { name: "訂單摘要" })).toBeVisible();
  await expect(page.locator("#checkout-total")).toHaveText("1,460");
  await expect(page.getByLabel("收件人姓名")).toHaveAttribute("autocomplete", "shipping name");
  await expect(page.getByLabel("收件人電話")).toHaveAttribute("inputmode", "tel");
  await expect(page.getByLabel("收件地址")).toHaveAttribute("autocomplete", "shipping street-address");
  for (const width of [320, 375, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    expect((await page.getByRole("heading", { level: 1, name: "結帳" }).boundingBox())!.height).toBe(cartTitleHeights.get(width));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect((await analyzeWhenSettled(page)).violations).toEqual([]);
    await testInfo.attach(`checkout-${width}`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
  }
  await page.getByLabel("收件人姓名").fill("   ");
  await page.getByLabel("收件人電話").fill("0912345678");
  await page.getByLabel("收件地址").fill("台北市中正區測試地址");
  await page.getByLabel(/我確認配送地點位於台灣本島/).check();
  await page.getByRole("button", { name: "送出訂單" }).click();
  await expect(page.locator("#name-error")).toContainText("請填寫收件人姓名。");
  await expect(page.getByLabel("收件人姓名")).toHaveAttribute("aria-describedby", "name-error");
  await expect(page.getByLabel("收件人姓名")).toHaveAttribute("aria-invalid", "true");
  expect((await analyzeWhenSettled(page)).violations).toEqual([]);
  await page.getByLabel("收件人姓名").fill("購物車測試");
  await page.getByLabel(/我確認配送地點位於台灣本島/).check();
  await page.getByRole("button", { name: "送出訂單" }).click();
  await expect(page).toHaveURL(/\/orders\/\d+\?placed=1$/);
  // URL commitment precedes module execution. Do not abort the order page before
  // it confirms the placed order and clears the cart; observe the completed UI.
  await page.waitForLoadState("load");
  await expect(page.locator("#cart-count")).toHaveText("0");
  await page.goto("/cart");
  await expect(page.getByRole("heading", { name: "購物車目前是空的" })).toBeVisible();
  await expect(page.locator("#cart-empty").getByRole("link", { name: "挑選商品" })).toBeVisible();
  await page.goto("/products");
  await product.getByRole("button", { name: "加入購物車" }).click();
  await expect(page.locator("#cart-count")).toHaveText("1");
  await page.goto("/cart");
  await row.getByRole("button", { name: "移除" }).click();
  await expect(page.getByRole("heading", { name: "購物車目前是空的" })).toBeVisible();
  await expect(page.locator("#cart-empty").getByRole("link", { name: "挑選商品" })).toBeFocused();
});
