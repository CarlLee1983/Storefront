import AxeBuilder from "@axe-core/playwright";
import { expect, test, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";
import { adminAccessHeaders } from "../harness/admin-access";
import { seedListedProducts } from "../harness/admin-seed";
import { BASE_URL } from "../harness/constants";
import { memberSessionCookie } from "../harness/session-cookie";
import { gotoProductList } from "../harness/admin-list";

const TABLE = "變體餐桌";
const MUG = "變體單品杯";
const CATEGORY = { slug: "e2e-variants", name: "變體分類", description: "商品變體測試用的分類" };
const VIEWPORTS = [{ name: "手機", width: 375, height: 812 }, { name: "桌機", width: 1280, height: 900 }] as const;

/** 後台表單 POST 要帶同源的 Origin（Astro 的 CSRF 檢查）；成功是 303。 */
async function post(request: APIRequestContext, path: string, form: Record<string, string>) {
  const response = await request.post(path, { form, headers: { origin: BASE_URL }, maxRedirects: 0 });
  expect(response.status(), `${path} ${JSON.stringify(form)}`).toBe(303);
}

/** 商品編輯頁上每個變體卡片的編號，依頁面順序（預設變體在前）。 */
async function variantIdsOf(request: APIRequestContext, productId: number): Promise<number[]> {
  const html = await (await request.get(`/admin/products/${productId}`)).text();
  return [...html.matchAll(/id="variant-(\d+)"/g)].map((match) => Number(match[1]));
}

// 商品與變體由 beforeAll 建立一次，各測試依序共用它們（並行會讓每個 worker 各建一份而互相衝突）
test.describe.configure({ mode: "serial" });

let admin: BrowserContext;
let tableId: number;
let mugId: number;
/** 後台操作測試各用一個還沒有選項的商品（手機、桌機各一），避免第二個測試遇到第一個留下的選項。 */
const adminProducts = { 手機: { name: "變體後台手機杯", id: 0 }, 桌機: { name: "變體後台桌機杯", id: 0 } };
let variantIds: number[];

test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  admin = await browser.newContext({ baseURL: BASE_URL, extraHTTPHeaders: adminAccessHeaders() });
  const ids = await seedListedProducts(admin, CATEGORY, [
    { name: TABLE, priceTwd: 9000, stock: 3 },
    { name: MUG, priceTwd: 320, stock: 5 },
    { name: adminProducts.手機.name, priceTwd: 320, stock: 1 },
    { name: adminProducts.桌機.name, priceTwd: 320, stock: 1 },
  ]);
  [tableId, mugId] = ids as [number, number];
  adminProducts.手機.id = ids[2]!;
  adminProducts.桌機.id = ids[3]!;
  // 餐桌：尺寸一個維度、三個變體（120 公分是預設變體，有 3 件）；150 公分特價、2 件；180 公分 1 件
  await post(admin.request, `/admin/products/${tableId}`, { intent: "set-options", optionName1: "尺寸", defaultValue1: "120 公分" });
  await post(admin.request, `/admin/products/${tableId}`, { intent: "create-variant", value1: "150 公分", priceTwd: "12000", compareAtPriceTwd: "15000" });
  await post(admin.request, `/admin/products/${tableId}`, { intent: "create-variant", value1: "180 公分", priceTwd: "15000" });
  variantIds = await variantIdsOf(admin.request, tableId);
  expect(variantIds).toHaveLength(3);
  await post(admin.request, `/admin/products/${tableId}`, { intent: "adjust-variant-stock", variantId: String(variantIds[1]), delta: "+2", reason: "E2E 補貨" });
  await post(admin.request, `/admin/products/${tableId}`, { intent: "adjust-variant-stock", variantId: String(variantIds[2]), delta: "+1", reason: "E2E 補貨" });
});

test.afterAll(async () => {
  // 特價與商品列表是全域狀態：用完下架，不影響其他 spec
  try { for (const id of [tableId, mugId, adminProducts.手機.id, adminProducts.桌機.id]) await post(admin.request, "/admin", { intent: "unlist", id: String(id) }); }
  finally { await admin.close(); }
});

for (const viewport of VIEWPORTS) {
  test(`${viewport.name}：選取變體即時顯示確切價格與可售量，選項好按、無水平捲動，可把不同變體分別加入購物車`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto(`/products/${tableId}`);
    const info = page.getByRole("region", { name: "商品資訊" });
    const size = info.getByRole("group", { name: "尺寸" });

    // 初始選取預設變體
    await expect(info.locator("#variant-price .price-now")).toHaveText("NT$ 9,000");
    await expect(info.locator("#variant-availability")).toHaveText("僅剩 3 件現貨");
    await expect(size.getByRole("radio", { name: "120 公分" })).toBeChecked();
    for (const label of await size.locator("label").all()) expect((await label.locator("span").first().boundingBox())!.height).toBeGreaterThanOrEqual(44);

    // 特價變體：確切價格、劃線原價、折扣標籤、可售量
    await size.getByText("150 公分").click();
    await expect(info.locator("#variant-price .price-now")).toHaveText("NT$ 12,000");
    await expect(info.locator("#variant-price .price-was")).toContainText("15,000");
    await expect(info.locator("#variant-price .sale-tag")).toBeVisible();
    await expect(info.locator("#variant-availability")).toHaveText("僅剩 2 件現貨");
    await info.getByRole("button", { name: "加入購物車", exact: true }).click();
    await expect(info.getByRole("status")).toHaveText("已加入購物車，目前 1 件。");

    // 切回沒有特價的變體：劃線價消失
    await size.getByText("120 公分").click();
    await expect(info.locator("#variant-price .price-now")).toHaveText("NT$ 9,000");
    await expect(info.locator("#variant-price .price-was")).toBeHidden();
    await info.getByRole("button", { name: "加入購物車", exact: true }).click();
    // 提示的件數是這個變體在車內的數量：不同變體不合併，所以各自是 1 件
    await expect(info.getByRole("status")).toHaveText("已加入購物車，目前 1 件。");

    // 加入購物車的提示有淡入動畫：等動畫結束再掃描對比，避免掃到半透明的中間狀態
    await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished)));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

    // 購物車：同商品的不同變體各一筆，各自單價與選項
    await page.goto("/cart");
    const lines = page.locator("#cart-lines > li");
    await expect(lines).toHaveCount(2);
    await expect(lines.nth(0)).toContainText("150 公分");
    await expect(lines.nth(0)).toContainText("NT$ 12,000");
    await expect(lines.nth(1)).toContainText("120 公分");
    await expect(page.locator("#cart-total")).toHaveText("21,000");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  });
}

test("列表顯示價格範圍與有特價選項；無選項商品仍可從列表加入購物車", async ({ page }) => {
  await page.goto("/products");
  const table = page.getByRole("listitem").filter({ hasText: TABLE });
  await expect(table).toContainText("NT$ 9,000 – NT$ 15,000");
  await expect(table).toContainText("有特價選項");
  await expect(table.getByRole("button", { name: "加入購物車" })).toHaveCount(0);
  const mug = page.getByRole("listitem").filter({ hasText: MUG });
  await expect(mug).toContainText("NT$ 320");
  await mug.getByRole("button", { name: "加入購物車" }).click();
  await expect(page.locator("#cart-count")).toHaveText("1");
});

test("停賣的變體不再出現在商品頁與價格範圍，已在購物車的結帳時被擋下；恢復販售後可以購買", async ({ page }) => {
  await page.context().addCookies([memberSessionCookie()]);
  await page.goto(`/products/${tableId}`);
  const info = page.getByRole("region", { name: "商品資訊" });
  await info.getByRole("group", { name: "尺寸" }).getByText("180 公分").click();
  await expect(info.locator("#variant-price .price-now")).toHaveText("NT$ 15,000");
  await info.getByRole("button", { name: "加入購物車", exact: true }).click();
  await expect(info.getByRole("status")).toHaveText("已加入購物車，目前 1 件。");

  await post(admin.request, `/admin/products/${tableId}`, { intent: "discontinue-variant", variantId: String(variantIds[2]) });
  try {
    await page.goto(`/products/${tableId}`);
    await expect(info.getByRole("group", { name: "尺寸" }).getByRole("radio")).toHaveCount(2);
    await expect(info.getByRole("group", { name: "尺寸" }).getByText("180 公分")).toHaveCount(0);
    await page.goto("/products");
    await expect(page.getByRole("listitem").filter({ hasText: TABLE })).toContainText("NT$ 9,000 – NT$ 12,000");

    await page.goto("/checkout");
    await page.getByLabel("收件人姓名").fill("變體測試");
    await page.getByLabel("收件人電話").fill("0912345678");
    await page.getByLabel("收件地址").fill("台北市中正區測試地址");
    await page.getByLabel(/我確認配送地點位於台灣本島/).check();
    await page.getByRole("button", { name: "送出訂單" }).click();
    await expect(page.locator("#checkout-issues")).toContainText("已停賣，請從購物車移除");
    await page.locator("#checkout-issues").getByRole("button", { name: "移除" }).click();
    await expect(page.locator("#checkout-issues li")).toHaveCount(0);
  } finally {
    await post(admin.request, `/admin/products/${tableId}`, { intent: "resume-variant", variantId: String(variantIds[2]) });
  }
  await page.goto(`/products/${tableId}`);
  await expect(info.getByRole("group", { name: "尺寸" }).getByRole("radio")).toHaveCount(3);
});

for (const viewport of VIEWPORTS) {
  test(`${viewport.name}：管理員在商品編輯頁設定選項、新增變體、調整庫存並停賣`, async ({ browser }) => {
    const context = await browser.newContext({ baseURL: BASE_URL, extraHTTPHeaders: adminAccessHeaders(), viewport: { width: viewport.width, height: viewport.height } });
    try {
      const page: Page = await context.newPage();
      const product = adminProducts[viewport.name];
      await page.goto(`/admin/products/${product.id}`);
      const options = page.getByRole("form", { name: "選項維度" });
      await options.getByLabel("選項維度 1 名稱").fill("顏色");
      await options.getByLabel("預設變體的選項值 1").fill("白");
      await options.getByRole("button", { name: "套用選項維度" }).click();
      await expect(page.getByRole("status").filter({ hasText: "已儲存選項與變體" })).toBeVisible();

      const create = page.getByRole("form", { name: "新增變體" });
      await create.getByLabel("顏色").fill("黑");
      await create.getByLabel("單價（新台幣整數元）").fill("360");
      await create.getByRole("button", { name: "新增變體" }).click();
      await expect(page.locator(".variant-card")).toHaveCount(2);

      // 重複的選項組合被擋下並顯示原因
      await page.getByRole("form", { name: "新增變體" }).getByLabel("顏色").fill("黑");
      await page.getByRole("form", { name: "新增變體" }).getByLabel("單價（新台幣整數元）").fill("360");
      await page.getByRole("form", { name: "新增變體" }).getByRole("button", { name: "新增變體" }).click();
      await expect(page.getByRole("alert")).toContainText("已有相同選項組合的變體");

      const black = page.locator(".variant-card").filter({ hasText: "黑" });
      await black.getByLabel("黑的庫存增減量").fill("+4");
      await black.getByLabel("黑的庫存調整原因").fill("E2E 補貨");
      await black.getByRole("button", { name: "調整庫存" }).click();
      await expect(page.locator(".variant-card").filter({ hasText: "黑" })).toContainText("在庫 4，不可售 0，保留 0，可售 4");
      await page.locator(".variant-card").filter({ hasText: "黑" }).getByRole("button", { name: "停賣" }).click();
      await expect(page.locator(".variant-card").filter({ hasText: "黑" })).toContainText("已停賣");
      // 圖庫腳本載入前上傳按鈕是停用的（停用狀態的對比不在此檢查範圍）：等它就緒再掃描
      await expect(page.getByRole("button", { name: "上傳商品圖片" })).toBeEnabled();
      await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished)));
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

      // 後台清單的多變體商品以彙總呈現，庫存改到編輯頁管理
      await gotoProductList(page, product.name);
      const row = page.getByRole("row", { name: new RegExp(product.name) });
      await expect(row.getByRole("link", { name: "管理變體庫存" })).toBeVisible();
    } finally { await context.close(); }
  });
}
