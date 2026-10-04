import { expect, test } from "@playwright/test";
import { adminAccessHeaders } from "../harness/admin-access";
import { assignSharedCategory } from "../harness/admin-categories";
import { BASE_URL } from "../harness/constants";
import { memberSessionCookie } from "../harness/session-cookie";
import { gotoOrderList, gotoProductList } from "../harness/admin-list";
import { analyzeWhenSettled } from "../harness/axe";

const name = "訂單封面測試商品";

test("訂單封面、付款重點、手機排版與取消中斷", async ({ browser, page }, testInfo) => {
  test.setTimeout(180_000);
  const adminContext = await browser.newContext({ baseURL: BASE_URL, extraHTTPHeaders: adminAccessHeaders() });
  try {
    const admin = await adminContext.newPage();
    await admin.goto("/admin/products/new");
    await admin.getByLabel("名稱", { exact: true }).fill(name);
    await admin.getByLabel("說明", { exact: true }).fill("訂單中持續顯示目前封面");
    await admin.getByLabel("單價（新台幣整數元）").fill("680");
    await admin.getByRole("button", { name: "新增商品" }).click();
    await expect(admin.getByRole("status").filter({ hasText: "已新增商品。" })).toHaveText("已新增商品。");
    await assignSharedCategory(admin, name);
    const row = admin.getByRole("row", { name: new RegExp(name) });
    await row.getByLabel(`${name}的庫存增減量`).fill("5");
    await row.getByLabel(`${name}的庫存調整原因`).fill("E2E 補貨");
    await row.getByRole("button", { name: "調整庫存" }).click();
    await expect(admin.getByRole("status")).toHaveText("已調整庫存。");
    await row.getByRole("link", { name: "編輯" }).click();
    const png = await admin.evaluate(() => {
      const canvas = document.createElement("canvas"); canvas.width = 400; canvas.height = 300;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#dbeafe"; ctx.fillRect(0, 0, 400, 300);
      ctx.fillStyle = "#174ea6"; ctx.fillRect(130, 70, 140, 160);
      return canvas.toDataURL("image/png").split(",")[1]!;
    });
    await admin.getByLabel("商品圖片（JPEG、PNG 或 WebP，20 MB 以內）").setInputFiles({ name: "order-cover.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") });
    await admin.getByRole("button", { name: "上傳商品圖片" }).click();
    await expect(admin.locator("#image-status")).toContainText("已上傳商品圖片");
    await gotoProductList(admin, name);
    await row.getByRole("button", { name: "重新上架" }).click();
    await expect(row).toContainText("上架中");

    await page.context().addCookies([memberSessionCookie()]);
    await page.goto("/products");
    await page.getByRole("listitem").filter({ hasText: name }).getByRole("button", { name: "加入購物車" }).click();
    await expect(page.locator("#cart-count")).toHaveText("1");
    await page.goto("/checkout");
    await page.getByLabel("收件人姓名").fill("訂單測試");
    await page.getByLabel("收件人電話").fill("0912345678");
    await page.getByLabel("收件地址").fill("台北市中正區測試地址");
    await page.getByLabel(/我確認配送地點位於台灣本島/).check();
    await page.getByRole("button", { name: "送出訂單" }).click();
    await expect(page).toHaveURL(/\/orders\/\d+\?placed=1$/);
    const path = new URL(page.url()).pathname;
    const id = path.split("/").pop()!;
    await expect(page.getByText("訂單狀態：待付款")).toBeVisible();
    await expect(page.getByRole("region", { name: "完成付款" }).getByText(/付款期限：/)).toBeVisible();
    const cover = page.getByRole("img", { name: name });
    await expect(cover).toHaveAttribute("srcset", /320w.*640w.*1280w/);
    await expect.poll(() => cover.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
    const source = await cover.getAttribute("src");
    for (const width of [320, 375, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(page.getByRole("region", { name: "訂單進度" })).toContainText("待付款");
      await expect(page.getByRole("region", { name: "收件資訊" })).toContainText("台北市中正區測試地址");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect((await analyzeWhenSettled(page)).violations).toEqual([]);
      await testInfo.attach(`order-detail-${width}`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
      await page.goto("/orders");
      const card = page.locator(".order-card").filter({ has: page.getByRole("link", { name: `訂單 #${id}`, exact: true }) });
      await expect(card.getByRole("img", { name: name })).toHaveAttribute("src", source!);
      await expect(card.getByRole("button", { name: `訂單 #${id} 前往付款` })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect((await analyzeWhenSettled(page)).violations).toEqual([]);
      await testInfo.attach(`order-list-${width}`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
      await card.getByRole("link", { name: `查看訂單 #${id} 詳情` }).click();
      await expect(page).toHaveURL(new RegExp(`${path}$`));
    }
    await page.getByRole("button", { name: "前往付款", exact: true }).click();
    await page.getByRole("radio", { name: "失敗", exact: true }).check();
    await page.getByRole("radio", { name: "立即回呼", exact: true }).check();
    await page.getByRole("button", { name: "送出", exact: true }).click();
    await expect(page.getByText("訂單狀態：待付款")).toBeVisible();
    for (const width of [375, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(page.getByRole("region", { name: "付款資訊" }).getByRole("row")).toHaveCount(2);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect((await analyzeWhenSettled(page)).violations).toEqual([]);
      await testInfo.attach(`order-payment-${width}`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
    }
    page.once("dialog", dialog => void dialog.dismiss());
    await page.getByRole("button", { name: "取消訂單" }).click();
    await expect(page.getByText("訂單狀態：待付款")).toBeVisible();
    await expect(page.getByRole("button", { name: "前往付款", exact: true })).toBeVisible();
    page.once("dialog", dialog => void dialog.accept());
    await page.getByRole("button", { name: "取消訂單" }).click();
    await expect(page.getByText("訂單狀態：已取消")).toBeVisible();
    await expect(page.getByRole("button", { name: "前往付款", exact: true })).toHaveCount(0);
    for (const width of [375, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect((await analyzeWhenSettled(page)).violations).toEqual([]);
    }
    await gotoOrderList(admin, id);
    const orderRow = admin.getByRole("row").filter({ has: admin.getByRole("link", { name: `#${id}`, exact: true }) });
    await expect(orderRow.getByRole("img", { name: `${name}的封面` })).toHaveAttribute("src", source!);
    await orderRow.getByRole("link", { name: `#${id}`, exact: true }).click();
    await expect(admin.getByRole("img", { name: `${name}的封面` })).toHaveAttribute("src", source!);
    expect((await analyzeWhenSettled(admin)).violations).toEqual([]);
    await testInfo.attach("admin-order-cover", { body: await admin.screenshot({ fullPage: true }), contentType: "image/png" });
    // Existing orders keep their lines when all images of an unlisted product are removed.
    await gotoProductList(admin, name);
    await row.getByRole("button", { name: "下架", exact: true }).click();
    await expect(row).toContainText("已下架");
    await row.getByRole("link", { name: "編輯" }).click();
    admin.once("dialog", dialog => void dialog.accept());
    await admin.getByRole("button", { name: "刪除商品圖片 1", exact: true }).click();
    await expect(admin.locator("#product-images img")).toHaveCount(0);
    for (const location of [path, "/orders"]) {
      await page.goto(location);
      await expect(page.getByRole("img", { name: `${name}暫無商品圖片` })).toBeVisible();
      expect((await analyzeWhenSettled(page)).violations).toEqual([]);
    }
    await admin.goto(`/admin${path}`);
    await expect(admin.getByRole("img", { name: `${name}暫無商品圖片` })).toBeVisible();

  } finally { await adminContext.close(); }
});
