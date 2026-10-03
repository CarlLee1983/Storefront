import AxeBuilder from "@axe-core/playwright";
import { expect, test, type BrowserContext } from "@playwright/test";
import { adminAccessHeaders } from "../harness/admin-access";
import { unlistProduct, seedListedProducts } from "../harness/admin-seed";
import { BASE_URL } from "../harness/constants";

const CATEGORY = { slug: "e2e-product-info", name: "商品資訊分類", description: "尺寸材質保養測試用的分類" };
const WITH_INFO = "資訊齊全邊桌";
const WITHOUT_INFO = "未填資訊小凳";
const INFO = { dimensions: "寬 45 × 深 45 × 高 55 cm", material: "北美胡桃木實木", care: "以乾布擦拭，避免長時間日曬。" };
const VIEWPORTS = [{ name: "手機", width: 375, height: 812 }, { name: "桌機", width: 1280, height: 900 }] as const;

test.describe.configure({ mode: "serial" });

let admin: BrowserContext;
let withInfoId: number;
let withoutInfoId: number;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  admin = await browser.newContext({ baseURL: BASE_URL, extraHTTPHeaders: adminAccessHeaders() });
  [withInfoId, withoutInfoId] = (await seedListedProducts(admin, CATEGORY, [
    { name: WITH_INFO, priceTwd: 4800, stock: 3 },
    { name: WITHOUT_INFO, priceTwd: 1200, stock: 3 },
  ])) as [number, number];
});

test.afterAll(async () => {
  // 商品列表是全域狀態：用完下架，不影響其他 spec
  try {
    for (const id of [withInfoId, withoutInfoId]) {
      await unlistProduct(admin.request, id);
    }
  } finally { await admin.close(); }
});

test("管理員在編輯頁填寫尺寸、材質與保養後儲存，重新開啟仍保留", async () => {
  const page = await admin.newPage();
  await page.goto(`/admin/products/${withInfoId}`);
  await page.getByLabel("尺寸（選填）").fill(INFO.dimensions);
  await page.getByLabel("材質（選填）").fill(INFO.material);
  await page.getByLabel("保養（選填）").fill(INFO.care);
  await page.getByRole("button", { name: "儲存變更" }).click();

  await page.goto(`/admin/products/${withInfoId}`);
  await expect(page.getByLabel("尺寸（選填）")).toHaveValue(INFO.dimensions);
  await expect(page.getByLabel("材質（選填）")).toHaveValue(INFO.material);
  await expect(page.getByLabel("保養（選填）")).toHaveValue(INFO.care);
  await page.close();
});

for (const viewport of VIEWPORTS) {
  test(`${viewport.name}：商品頁顯示尺寸、材質與保養，沒填的商品不出現該區塊，無水平捲動、無 axe 違規`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });

    await page.goto(`/products/${withInfoId}`);
    const specs = page.getByRole("region", { name: "尺寸、材質與保養" });
    await expect(specs.getByText("尺寸", { exact: true })).toBeVisible();
    await expect(specs).toContainText(INFO.dimensions);
    await expect(specs).toContainText(INFO.material);
    await expect(specs).toContainText(INFO.care);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

    await page.goto(`/products/${withoutInfoId}`);
    await expect(page.getByRole("heading", { level: 1, name: WITHOUT_INFO })).toBeVisible();
    await expect(page.getByRole("region", { name: "尺寸、材質與保養" })).toHaveCount(0);
  });
}

test("沒有管理員身分無法儲存商品資訊，既有內容不變", async ({ request }) => {
  const response = await request.post(`/admin/products/${withInfoId}`, { form: { name: "x", description: "", priceTwd: "1", care: "駭入" }, headers: { origin: BASE_URL }, maxRedirects: 0 });
  expect(response.status()).toBe(403);

  const page = await admin.newPage();
  await page.goto(`/admin/products/${withInfoId}`);
  await expect(page.getByLabel("保養（選填）")).toHaveValue(INFO.care);
  await page.close();
});
