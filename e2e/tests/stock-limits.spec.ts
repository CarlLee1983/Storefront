import { expect, test, type Page } from "@playwright/test";
import { adminAccessHeaders } from "../harness/admin-access";
import { assignSharedCategory } from "../harness/admin-categories";
import { gotoProductList } from "../harness/admin-list";
import { BASE_URL } from "../harness/constants";
import { memberSessionCookie } from "../harness/session-cookie";

const PRODUCT = "可售數量限制花器";
const PRICE = 680;
let productPath: string;
let variantId: number;

async function createStockedProduct(admin: Page) {
  await admin.goto("/admin/products/new");
  await admin.getByLabel("名稱", { exact: true }).fill(PRODUCT);
  await admin.getByLabel("說明", { exact: true }).fill("可售數量前台回歸測試。");
  await admin.getByLabel("單價（新台幣整數元）").fill(String(PRICE));
  await admin.getByRole("button", { name: "新增商品" }).click();
  await expect(admin.getByRole("status").filter({ hasText: "已新增商品。" })).toBeVisible();
  await assignSharedCategory(admin, PRODUCT);
  const row = admin.getByRole("row", { name: new RegExp(PRODUCT) });
  await row.getByLabel(`${PRODUCT}的庫存增減量`).fill("4");
  await row.getByLabel(`${PRODUCT}的庫存調整原因`).fill("E2E 補貨");
  await row.getByRole("button", { name: "調整庫存" }).click();
  await expect(admin.getByRole("status")).toHaveText("已調整庫存。");
  await row.getByRole("link", { name: "編輯" }).click();
  const id = new URL(admin.url()).pathname.split("/").pop()!;
  const png = await admin.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = 400; canvas.height = 300;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#e5d8c5"; context.fillRect(0, 0, 400, 300);
    return canvas.toDataURL("image/png").split(",")[1]!;
  });
  await admin.getByLabel("商品圖片（JPEG、PNG 或 WebP，20 MB 以內）").setInputFiles({ name: "cover.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") });
  await admin.getByRole("button", { name: "上傳商品圖片" }).click();
  await expect(admin.locator("#image-status")).toContainText("已上傳商品圖片");
  await gotoProductList(admin, PRODUCT);
  await row.getByRole("button", { name: "重新上架" }).click();
  await expect(row).toContainText("上架中");
  return `/products/${id}`;
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({ baseURL: BASE_URL, extraHTTPHeaders: adminAccessHeaders() });
  try {
    const admin = await context.newPage();
    productPath = await createStockedProduct(admin);
    await admin.goto(productPath);
    variantId = Number(await admin.locator("#buy-form").getAttribute("data-variant-id"));
    expect(variantId).toBeGreaterThan(0);
  }
  finally { await context.close(); }
});

test("可售 4 件：商品頁不得選超量，合併加入整次拒絕，列表快速加入也守住上限", async ({ page }) => {
  await page.goto(productPath);
  const information = page.getByRole("region", { name: "商品資訊" });
  const quantity = information.getByLabel("數量", { exact: true });
  const add = information.getByRole("button", { name: "加入購物車", exact: true });
  const availability = await page.request.get(`/api/availability?variants=${variantId},999999999`);
  expect(availability.ok()).toBe(true);
  expect(availability.headers()["cache-control"]).toContain("no-store");
  expect(await availability.json()).toEqual({ variants: [{ variantId, available: 4 }] });
  await expect(quantity).toHaveAttribute("max", "4");
  await quantity.fill("3");
  await add.click();
  await expect(page.locator("#cart-count")).toHaveText("1");
  await quantity.fill("2");
  await add.click();
  await expect(information.getByRole("status")).toContainText("購物車已有 3 件，最多還能加入 1 件");
  await expect(page.locator("#cart-count")).toHaveText("1");
  await page.goto("/products");
  const card = page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: PRODUCT, exact: true }) });
  await card.getByRole("button", { name: `加入購物車：${PRODUCT}` }).click();
  await expect(card.getByRole("status")).toHaveText("已加入購物車，目前 4 件。");
  await expect(page.locator("#cart-count")).toHaveText("1");
  await card.getByRole("button", { name: `加入購物車：${PRODUCT}` }).click();
  await expect(card.getByRole("status")).toContainText("最多還能加入 0 件");
  await expect(page.locator("#cart-count")).toHaveText("1");
});

async function addThree(page: Page) {
  await page.goto(productPath);
  const information = page.getByRole("region", { name: "商品資訊" });
  await information.getByLabel("數量", { exact: true }).fill("3");
  await information.getByRole("button", { name: "加入購物車", exact: true }).click();
  await expect(page.locator("#cart-count")).toHaveText("1");
}

test("購物車庫存下降時保留原數量、阻擋結帳；減量後恢復", async ({ page }) => {
  await addThree(page);
  await page.route("**/api/availability?*", route => route.fulfill({ json: { variants: [{ variantId, available: 2 }] } }));
  await page.goto("/cart");
  const line = page.getByRole("listitem").filter({ hasText: PRODUCT });
  const quantity = line.getByLabel(`${PRODUCT} 數量`);
  const checkout = page.getByRole("link", { name: "前往結帳" });
  await expect(quantity).toHaveValue("3");
  await expect(line).toContainText("目前僅可購買 2 件");
  await expect(checkout).toHaveAttribute("aria-disabled", "true");
  await line.getByRole("button", { name: `減少${PRODUCT}數量` }).click();
  await expect(quantity).toHaveValue("2");
  await expect(checkout).not.toHaveAttribute("aria-disabled", "true");
});

test("查詢失敗時禁止加入及增加，保留減量與重試", async ({ page }) => {
  await page.route("**/api/availability?*", route => route.abort("failed"));
  await page.goto(productPath);
  const information = page.getByRole("region", { name: "商品資訊" });
  await information.getByRole("button", { name: "加入購物車", exact: true }).click();
  await expect(page.locator("#cart-count")).toHaveText("0");
  await expect(page.locator("#variant-availability")).toContainText("暫時無法確認庫存");
  await expect(information.getByRole("button", { name: "重新確認庫存" })).toBeVisible();
  await page.unroute("**/api/availability?*");
  await information.getByRole("button", { name: "重新確認庫存" }).click();
  await information.getByRole("button", { name: "加入購物車", exact: true }).click();
  await expect(page.locator("#cart-count")).toHaveText("1");

  await page.route("**/api/availability?*", route => route.abort("failed"));
  await page.goto("/cart");
  const line = page.getByRole("listitem").filter({ hasText: PRODUCT });
  await expect(page.getByRole("link", { name: "前往結帳" })).toHaveAttribute("aria-disabled", "true");
  await expect(line.getByRole("button", { name: `增加${PRODUCT}數量` })).toBeDisabled();
  await expect(line.getByLabel(`${PRODUCT} 數量`)).toHaveValue("1");
  await line.getByRole("button", { name: "移除" }).click();
  await expect(page.getByRole("heading", { name: "購物車目前是空的" })).toBeVisible();
});

test("購物車手動增加等待查詢時，跨分頁重繪後仍顯示已儲存數量", async ({ page }) => {
  await page.goto(productPath);
  await page.getByRole("region", { name: "商品資訊" }).getByRole("button", { name: "加入購物車", exact: true }).click();
  await expect(page.locator("#cart-count")).toHaveText("1");
  await page.goto("/cart");
  const line = page.getByRole("listitem").filter({ hasText: PRODUCT });
  const quantity = line.getByLabel(`${PRODUCT} 數量`);
  await expect(page.getByRole("link", { name: "前往結帳" })).not.toHaveAttribute("aria-disabled", "true");
  let release!: () => void;
  let intercepted = false;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/availability?*", async route => {
    intercepted = true;
    await pending;
    await route.fulfill({ json: { variants: [{ variantId, available: 4 }] } });
  });
  try {
    await quantity.fill("2");
    await quantity.press("Tab");
    await expect.poll(() => intercepted).toBe(true);
    await page.evaluate(() => window.dispatchEvent(new StorageEvent("storage", { key: "storefront.cart" })));
  } finally { release(); }
  await expect(quantity).toHaveValue("2");
  await expect(page.locator("#cart-total")).toHaveText("1,360");
});

test("結帳頁可直接修正超量，保留收件資料並重新試算", async ({ page }) => {
  await page.context().addCookies([memberSessionCookie()]);
  await addThree(page);
  await page.route("**/api/availability?*", route => route.fulfill({ json: { variants: [{ variantId, available: 2 }] } }));
  await page.goto("/checkout");
  await page.getByLabel("收件人姓名").fill("庫存測試");
  await page.getByLabel("收件人電話").fill("0912345678");
  await page.getByLabel("收件地址").fill("台北市中正區測試地址");
  const line = page.getByRole("row").filter({ hasText: PRODUCT });
  await expect(line.getByLabel(`${PRODUCT} 數量`)).toHaveValue("3");
  await expect(page.getByRole("button", { name: "送出訂單" })).toBeDisabled();
  await line.getByRole("button", { name: `減少${PRODUCT}數量` }).click();
  await expect(line.getByLabel(`${PRODUCT} 數量`)).toHaveValue("2");
  await expect(page.locator("#checkout-subtotal")).toHaveText("1,360");
  await expect(page.locator("#checkout-total")).toHaveText("1,460");
  await expect(page.getByLabel("收件人姓名")).toHaveValue("庫存測試");
  await expect(page.getByLabel("收件人電話")).toHaveValue("0912345678");
  await expect(page.getByLabel("收件地址")).toHaveValue("台北市中正區測試地址");
  await expect(page.getByRole("button", { name: "送出訂單" })).toBeEnabled();
});

test("pageshow 重新確認購物車快取頁的庫存", async ({ page }) => {
  await addThree(page);
  let available = 4;
  await page.route("**/api/availability?*", route => route.fulfill({ json: { variants: [{ variantId, available }] } }));
  await page.goto("/cart");
  const checkout = page.getByRole("link", { name: "前往結帳" });
  await expect(checkout).not.toHaveAttribute("aria-disabled", "true");
  available = 2;
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
  await expect(page.getByRole("listitem").filter({ hasText: PRODUCT })).toContainText("目前僅可購買 2 件");
  await expect(checkout).toHaveAttribute("aria-disabled", "true");
});
