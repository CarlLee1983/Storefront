import { expect, test, type Page } from "@playwright/test";
import { adminAccessHeaders } from "../harness/admin-access";
import { defaultVariantIds, seedListedProducts, unlistProductsByPrefix } from "../harness/admin-seed";
import { BASE_URL } from "../harness/constants";
import { memberSessionCookie } from "../harness/session-cookie";
import { analyzeWhenSettled } from "../harness/axe";

async function assertShell(page: Page, current: string, width: number) {
  const header = page.getByRole("banner");
  await expect(header.getByRole("link", { name: "管理後台 Still Life", exact: true })).toHaveAttribute("href", "/admin");
  await expect(header.getByRole("link", { name: "前往前台", exact: true })).toHaveAttribute("href", "/");
  await expect(page.getByRole("contentinfo")).toHaveCount(0);
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "跳到主要內容" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("main")).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  const open = page.getByRole("button", { name: "開啟後台選單" });
  if (await open.isVisible()) await open.click();
  const nav = page.getByRole("navigation", { name: "後台導覽" });
  await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);
  await expect(nav.getByRole("link", { name: current, exact: true })).toHaveAttribute("aria-current", "page");
  if (await page.getByRole("dialog", { name: "後台選單" }).isVisible()) {
    expect((await analyzeWhenSettled(page)).violations).toEqual([]);
    await page.getByRole("button", { name: "關閉後台選單" }).click();
    await expect(open).toBeFocused();
  }
  for (const control of await page.locator('a, button, input:not([type="hidden"]), textarea, select').all()) {
    const box = await control.boundingBox();
    if (!box) continue;
    expect(box.width, await control.evaluate(element => element.outerHTML)).toBeGreaterThanOrEqual(44);
    expect(box.height, await control.evaluate(element => element.outerHTML)).toBeGreaterThanOrEqual(44);
  }
  expect((await analyzeWhenSettled(page)).violations).toEqual([]);
}

async function assertEditForm(page: Page, width: number) {
  const box = (await page.getByRole("textbox", { name: /名稱/ }).first().boundingBox())!;
  expect(box.width).toBeLessThanOrEqual(640);
  if (width === 1280) expect(box.width).toBe(640);
  const save = (await page.getByRole("button", { name: /^儲存(變更)?$/ }).boundingBox())!;
  const cancel = (await page.getByRole("link", { name: "取消", exact: true }).boundingBox())!;
  expect(cancel.x - (save.x + save.width)).toBeGreaterThanOrEqual(8);
}

for (const width of [375, 1280]) {
  test(`後台共用外殼、表單與無障礙（${width}px）`, async ({ browser, page }, testInfo) => {
    test.setTimeout(180_000);
    const context = await browser.newContext({ baseURL: BASE_URL, extraHTTPHeaders: adminAccessHeaders(), viewport: { width, height: 900 } });
    const admin = await context.newPage();
    const prefix = `後台外殼${width}`;
    try {
      const ids = await seedListedProducts(context, { slug: `admin-shell-${width}`, name: prefix, description: "後台共用版面測試" }, [
        { name: `${prefix}商品一`, priceTwd: 100, stock: 5 },
        { name: `${prefix}商品二`, priceTwd: 200, stock: 5 },
      ]);
      await admin.goto(`/admin/products/${ids[0]}`);
      const categoryId = await admin.getByLabel("分類", { exact: true }).inputValue();
      await assertShell(admin, "商品管理", width);
      await expect(admin.getByRole("navigation", { name: "麵包屑" }).getByRole("link", { name: "商品管理" })).toHaveAttribute("href", "/admin/products");
      await assertEditForm(admin, width);
      expect((await admin.getByLabel("分類", { exact: true }).boundingBox())!.height).toBe((await admin.getByLabel("名稱", { exact: true }).boundingBox())!.height);
      await testInfo.attach(`product-edit-${width}`, { body: await admin.screenshot({ fullPage: true }), contentType: "image/png" });
      await admin.goto(`/admin/categories/${categoryId}`);
      await assertShell(admin, "分類管理", width);
      await expect(admin.getByRole("navigation", { name: "麵包屑" }).getByRole("link", { name: "分類管理" })).toHaveAttribute("href", "/admin/categories");
      await assertEditForm(admin, width);
      for (const [path, current] of [["/admin/products", "商品管理"], ["/admin/categories", "分類管理"], ["/admin/orders", "訂單管理"]] as const) {
        await admin.goto(path);
        await assertShell(admin, current, width);
      }
      const filter = (await admin.getByLabel("訂單狀態").boundingBox())!;
      const button = (await admin.getByRole("button", { name: "查找", exact: true }).boundingBox())!;
      expect(filter.width).toBeLessThanOrEqual(240);
      expect(filter.height).toBe(button.height);
      // 側欄縮小內容寬度，篩選欄位可換行；桌機動作仍接在最後一個日期欄位右側。
      if (width === 1280) {
        const lastFilter = (await admin.getByLabel("成立日期（迄）").boundingBox())!;
        expect(button.y + button.height).toBe(lastFilter.y + lastFilter.height);
        expect(button.x - (lastFilter.x + lastFilter.width)).toBeGreaterThanOrEqual(8);
      }

      await page.context().addCookies([memberSessionCookie()]);
      await page.goto("/cart");
      const variantIds = await defaultVariantIds(context.request, ids);
      await page.evaluate(({ ids, variantIds, prefix }) => localStorage.setItem("storefront.cart", JSON.stringify({ version: 2, lines: ids.map((productId, index) => ({ variantId: variantIds[index], productId, name: `${prefix}商品${index + 1}`, unitPriceTwd: (index + 1) * 100, quantity: 1 })) })), { ids, variantIds, prefix });
      await page.goto("/checkout");
      await page.getByLabel("收件人姓名").fill("後台測試");
      await page.getByLabel("收件人電話").fill("0912345678");
      await page.getByLabel("收件地址").fill("台北市中正區測試地址");
      await page.getByLabel(/我確認配送地點位於台灣本島/).check();
      await page.getByRole("button", { name: "送出訂單" }).click();
      await expect(page).toHaveURL(/\/orders\/\d+\?placed=1$/);
      const orderPath = new URL(page.url()).pathname;
      await page.getByRole("button", { name: "前往付款", exact: true }).click();
      await page.getByRole("radio", { name: "成功", exact: true }).check();
      await page.getByRole("radio", { name: "立即回呼", exact: true }).check();
      await page.getByRole("button", { name: "送出", exact: true }).click();
      await expect(page.getByText("訂單狀態：已付款")).toBeVisible();
      await admin.goto(`/admin${orderPath}`);
      await assertShell(admin, "訂單管理", width);
      await expect(admin.getByRole("navigation", { name: "麵包屑" }).getByRole("link", { name: "訂單管理" })).toHaveAttribute("href", "/admin/orders");
      expect((await admin.getByLabel("物流單號（可留空）").boundingBox())!.width).toBeLessThanOrEqual(640);
      await testInfo.attach(`order-detail-${width}`, { body: await admin.screenshot({ fullPage: true }), contentType: "image/png" });
      await admin.goto("/admin/orders");
      await assertShell(admin, "訂單管理", width);
      for (const [path, current] of [["/admin/products/999999999", "商品管理"], ["/admin/categories/999999999", "分類管理"], ["/admin/orders/999999999", "訂單管理"]] as const) {
        expect((await admin.goto(path))?.status()).toBe(404);
        await assertShell(admin, current, width);
      }
      await admin.setExtraHTTPHeaders({ "Cf-Access-Jwt-Assertion": "invalid" });
      for (const [path, current] of [["/admin/products", "商品管理"], ["/admin/categories", "分類管理"], ["/admin/orders", "訂單管理"]] as const) {
        expect((await admin.goto(path))?.status()).toBe(403);
        await assertShell(admin, current, width);
      }
    } finally {
      await unlistProductsByPrefix(context.request, prefix);
      await context.close();
    }
  });
}
