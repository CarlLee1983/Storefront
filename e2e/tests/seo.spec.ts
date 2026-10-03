import { expect, test, type BrowserContext } from "@playwright/test";
import { adminAccessHeaders } from "../harness/admin-access";
import { seedListedProducts } from "../harness/admin-seed";
import { BASE_URL } from "../harness/constants";

const CATEGORY = { slug: "e2e-seo", name: "結構化資料分類", description: "sitemap 與結構化資料測試用的分類" };

test.describe.configure({ mode: "serial" });

let admin: BrowserContext;
let listedId: number;
let unlistedId: number;

const unlist = (id: number) => admin.request.post("/admin", { form: { intent: "unlist", id: String(id) }, headers: { origin: BASE_URL }, maxRedirects: 0 });

test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  admin = await browser.newContext({ baseURL: BASE_URL, extraHTTPHeaders: adminAccessHeaders() });
  [listedId, unlistedId] = (await seedListedProducts(admin, CATEGORY, [
    { name: "結構化資料邊桌", priceTwd: 4800, stock: 3 },
    { name: "結構化資料下架凳", priceTwd: 1200, stock: 3 },
  ])) as [number, number];
  await unlist(unlistedId);
});

test.afterAll(async () => {
  try { await unlist(listedId); } finally { await admin.close(); }
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
