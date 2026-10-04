import { expect, test, type Page } from "@playwright/test";
import { adminAccessHeaders } from "../harness/admin-access";
import { unlistProduct, defaultVariantIds, seedListedProducts } from "../harness/admin-seed";
import { BASE_URL } from "../harness/constants";
import { analyzeWhenSettled } from "../harness/axe";

async function assertLayout(page: Page, width: number) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth), "page overflow").toBeLessThanOrEqual(width);
  for (const region of await page.getByRole("region", { name: /資料表/ }).all()) {
    const size = await region.evaluate(element => ({ width: element.clientWidth, scroll: element.scrollWidth }));
    expect(size.scroll, `table region overflow: ${await region.getAttribute("aria-label")}`).toBeLessThanOrEqual(size.width);
  }
  expect((await analyzeWhenSettled(page)).violations).toEqual([]);
}

for (const viewport of [{ name: "手機", width: 375, height: 812 }, { name: "桌機", width: 1280, height: 900 }]) {
  test(`${viewport.name}：設門檻後低庫存清單列出變體，補貨後移出；沒有 Access 的人進不了清單`, async ({ browser }) => {
    test.setTimeout(120_000);
    const name = `低庫存檯燈${viewport.width}`;
    const adminContext = await browser.newContext({ baseURL: BASE_URL, extraHTTPHeaders: adminAccessHeaders(), viewport });
    const anonymous = await browser.newContext({ baseURL: BASE_URL, viewport });
    const [productId] = await seedListedProducts(adminContext, { slug: `low-stock-${viewport.width}`, name: `低庫存分類${viewport.width}`, description: "低庫存提醒測試" }, [
      { name, priceTwd: 800, stock: 4 },
    ]) as [number];
    const admin = await adminContext.newPage();
    try {
      await admin.goto(`/admin/products/${productId}`);
      await admin.getByLabel("低庫存門檻（選填）").fill("5");
      await admin.getByRole("button", { name: "儲存門檻" }).click();
      await expect(admin.getByText("已儲存選項與變體。")).toBeVisible();

      await admin.goto("/admin/low-stock");
      const row = admin.getByRole("row").filter({ hasText: name });
      await expect(row.locator("td[data-label='門檻']")).toHaveText("5");
      await expect(row.locator("td[data-label='可售']")).toHaveText("4");
      await assertLayout(admin, viewport.width);

      // 補貨後可售超過門檻，提醒同步消失；補貨與盤損可由流水對回
      const [variantId] = await defaultVariantIds(adminContext.request, [productId]);
      const adjusted = await adminContext.request.post("/admin/products", { form: { intent: "adjust-stock", variantId: String(variantId), delta: "+10", reason: "低庫存補貨" }, headers: { origin: BASE_URL }, maxRedirects: 0 });
      expect(adjusted.status()).toBe(303);
      await admin.goto("/admin/low-stock");
      await expect(admin.getByRole("row").filter({ hasText: name })).toHaveCount(0);
      await admin.goto(`/admin/stock-movements?variantId=${variantId}`);
      await expect(admin.getByRole("row").filter({ hasText: "低庫存補貨" })).toContainText("14");

      expect((await anonymous.request.get("/admin/low-stock")).status()).toBe(403);
    } finally {
      await unlistProduct(adminContext.request, productId);
      await adminContext.close();
      await anonymous.close();
    }
  });
}
