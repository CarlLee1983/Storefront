import { expect, test, type APIRequestContext, type BrowserContext } from "@playwright/test";
import { adminAccessHeaders } from "../harness/admin-access";
import { seedListedProducts } from "../harness/admin-seed";
import { BASE_URL } from "../harness/constants";

const CATEGORY = { slug: "e2e-seo", name: "結構化資料分類", description: "sitemap 與結構化資料測試用的分類" };

test.describe.configure({ mode: "serial" });

let admin: BrowserContext;
let listedId: number;
let unlistedId: number;
let tableId: number;
let tableVariantIds: number[];
const VIEWPORTS = [{ name: "手機", width: 375, height: 812 }, { name: "桌機", width: 1280, height: 900 }] as const;

/** 後台表單 POST 要帶同源的 Origin；成功是 303。 */
async function post(request: APIRequestContext, path: string, form: Record<string, string>) {
  const response = await request.post(path, { form, headers: { origin: BASE_URL }, maxRedirects: 0 });
  expect(response.status(), `${path} ${JSON.stringify(form)}`).toBe(303);
}

const unlist = (id: number) => admin.request.post("/admin", { form: { intent: "unlist", id: String(id) }, headers: { origin: BASE_URL }, maxRedirects: 0 });

test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  admin = await browser.newContext({ baseURL: BASE_URL, extraHTTPHeaders: adminAccessHeaders() });
  [listedId, unlistedId, tableId] = (await seedListedProducts(admin, CATEGORY, [
    { name: "結構化資料邊桌", priceTwd: 4800, stock: 3 },
    { name: "結構化資料下架凳", priceTwd: 1200, stock: 3 },
    { name: "結構化資料餐桌", priceTwd: 9000, stock: 3 },
  ])) as [number, number, number];
  await unlist(unlistedId);
  // 餐桌：尺寸一個維度；120 公分是預設變體、150 公分 12,000 元有 2 件、180 公分之後停賣
  await post(admin.request, `/admin/products/${tableId}`, { intent: "set-options", optionName1: "尺寸", defaultValue1: "120 公分" });
  await post(admin.request, `/admin/products/${tableId}`, { intent: "create-variant", value1: "150 公分", priceTwd: "12000" });
  await post(admin.request, `/admin/products/${tableId}`, { intent: "create-variant", value1: "180 公分", priceTwd: "15000" });
  const html = await (await admin.request.get(`/admin/products/${tableId}`)).text();
  tableVariantIds = [...html.matchAll(/id="variant-(\d+)"/g)].map((match) => Number(match[1]));
  expect(tableVariantIds).toHaveLength(3);
  await post(admin.request, `/admin/products/${tableId}`, { intent: "adjust-variant-stock", variantId: String(tableVariantIds[1]), delta: "+2", reason: "E2E 補貨" });
  await post(admin.request, `/admin/products/${tableId}`, { intent: "discontinue-variant", variantId: String(tableVariantIds[2]) });
});

test.afterAll(async () => {
  try { await unlist(listedId); await unlist(tableId); } finally { await admin.close(); }
});

test("商品頁帶有與頁面一致的 Product JSON-LD", async ({ page }) => {
  await page.goto(`/products/${listedId}`);
  const raw = await page.locator('script[type="application/ld+json"]').textContent();
  const data = JSON.parse(raw ?? "{}");
  expect(data).toMatchObject({
    "@type": "Product", name: "結構化資料邊桌",
    offers: { "@type": "Offer", price: 4800, priceCurrency: "TWD", availability: "https://schema.org/InStock", url: `${BASE_URL}/products/${listedId}` },
  });
  await expect(page.locator("#variant-price .price-now")).toHaveText("NT$ 4,800");
});

test("sitemap 只列上架商品與公開頁，排除下架商品與帳戶、訂單、後台", async ({ request }) => {
  const response = await request.get("/sitemap.xml");
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("application/xml");
  const xml = await response.text();
  expect(xml).toContain(`<loc>${BASE_URL}/products/${listedId}</loc>`);
  expect(xml).toContain(`<loc>${BASE_URL}/categories/${CATEGORY.slug}</loc>`);
  expect(xml).not.toContain(`/products/${unlistedId}<`);
  for (const path of ["/admin", "/account", "/orders", "/cart", "/checkout"]) expect(xml).not.toContain(`${BASE_URL}${path}`);
});

test("robots.txt 引用 sitemap 並擋掉非公開路徑", async ({ request }) => {
  const text = await (await request.get("/robots.txt")).text();
  expect(text).toContain(`Sitemap: ${BASE_URL}/sitemap.xml`);
  expect(text).toContain("Disallow: /admin");
});

for (const viewport of VIEWPORTS) {
  test(`${viewport.name}：?variant= 直接開到該變體，JSON-LD 的變體網址與頁面一致，無效或停賣的退回預設`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const [, second, stopped] = tableVariantIds as [number, number, number];

    await page.goto(`/products/${tableId}?variant=${second}`);
    await expect(page.locator("#variant-price .price-now")).toHaveText("NT$ 12,000");
    await expect(page.locator("#variant-summary")).toHaveText("已選：150 公分");
    await expect(page.locator("form.buy-form")).toHaveAttribute("data-variant-id", String(second));
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", `${BASE_URL}/products/${tableId}`);

    const data = JSON.parse((await page.locator('script[type="application/ld+json"]').textContent()) ?? "{}");
    expect(data).toMatchObject({ "@type": "ProductGroup", url: `${BASE_URL}/products/${tableId}`, variesBy: ["https://schema.org/size"] });
    const variant = data.hasVariant.find((entry: { sku: string }) => entry.sku === `variant-${second}`);
    expect(variant).toMatchObject({ size: "150 公分", offers: { price: 12000, priceCurrency: "TWD", url: `${BASE_URL}/products/${tableId}?variant=${second}` } });
    expect(data.hasVariant).toHaveLength(2);

    for (const param of ["abc", "99999", String(stopped)]) {
      await page.goto(`/products/${tableId}?variant=${param}`);
      await expect(page.locator("#variant-price .price-now")).toHaveText("NT$ 9,000");
    }
  });
}
