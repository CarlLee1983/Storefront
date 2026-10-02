import AxeBuilder from "@axe-core/playwright";
import { expect, test as base, type Locator, type Page, type TestInfo } from "@playwright/test";
import { adminAccessHeaders } from "../harness/admin-access";
import { assignCategory, createCategory } from "../harness/admin-categories";
import { featureProduct } from "../harness/admin-featured";
import { seedListedProductsInCategory } from "../harness/admin-seed";
import { BASE_URL, GATEWAY_API_KEY, GATEWAY_URL, MEMBER } from "../harness/constants";
import { memberSessionCookie } from "../harness/session-cookie";

const PRODUCT = { name: "E2E 測試商品", description: "E2E 流程用的商品", priceTwd: "1200", compareAtPriceTwd: "1500" };
/** 主流程自己的分類。名稱刻意很短，導覽列才不會換行。 */
const CATEGORY = { slug: "e2e-main", name: "主流程", description: "E2E 主流程的分類" };
/**
 * 同分類的陪襯商品：24 件都比主流程商品貴，加上主流程商品共 25 件，超過一頁（24 件）才有「載入更多」。
 * 每 6 件有一件售完，「只看有貨」剩 21 件；陪襯商品都沒有原價，「只看特價」只剩主流程商品。
 */
const FILLERS = Array.from({ length: 24 }, (_, index) => ({ name: `主流程陪襯 ${String(index + 1).padStart(2, "0")}`, priceTwd: 2000 + index, stock: index % 6 === 0 ? 0 : 3 }));
const IN_STOCK_COUNT = 1 + FILLERS.filter(({ stock }) => stock > 0).length;
const TRACKING_NUMBER = "E2E-TRACK-0001";

// Navigate by real Tab presses, rather than programmatically focusing the target.
async function tabTo(page: Page, target: Locator) {
  for (let steps = 0; steps < 80; steps++) {
    if (await target.evaluate(element => element === document.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  await expect(target).toBeFocused();
}

const cards = (page: Page) => page.locator(".product-card");
const productCard = (page: Page) => cards(page).filter({ has: page.getByRole("heading", { level: 2, name: PRODUCT.name, exact: true }) });
const sortLink = (page: Page, label: string) => page.getByRole("navigation", { name: "排序" }).getByRole("link", { name: label });

const twd = (amount: string) => `NT$ ${Number(amount).toLocaleString("en-US")}`;
const DISCOUNT_PERCENT = Math.round((1 - Number(PRODUCT.priceTwd) / Number(PRODUCT.compareAtPriceTwd)) * 100);

/** 商品卡顯示特價：強調色售價、帶「原價」朗讀文字的劃線價與折扣標籤。 */
async function expectSaleCard(card: Locator) {
  await expect(card).toContainText(twd(PRODUCT.priceTwd));
  await expect(card.locator("s")).toHaveText(new RegExp(`原價\\s*${twd(PRODUCT.compareAtPriceTwd).replace("$", "\\$")}`));
  await expect(card.locator(".sale-tag")).toContainText(`−${DISCOUNT_PERCENT}%`);
}

async function audit(page: Page, testInfo: TestInfo, name: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations, name).toEqual([]);
  await testInfo.attach(name, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
}

const test = base.extend<{ admin: Page; gatewayConsole: Page }>({
  // 管理員 context 帶 Access JWT（與 Cloudflare Access 相同的 header），只會連到 Web；
  // 出貨表單有 confirm()，直接接受。fixture 結束時 context 一定會關閉
  admin: async ({ browser }, use) => {
    const context = await browser.newContext({ baseURL: BASE_URL, extraHTTPHeaders: adminAccessHeaders() });
    const page = await context.newPage();
    page.on("dialog", (dialog) => void dialog.accept());
    await use(page);
    await context.close();
  },
  // 閘道主控頁用 HTTP Basic（帳號任意，密碼為 GATEWAY_API_KEY）
  gatewayConsole: async ({ browser }, use) => {
    const context = await browser.newContext({ httpCredentials: { username: "e2e", password: GATEWAY_API_KEY } });
    await use(await context.newPage());
    await context.close();
  },
});

test("主流程：管理員建立分類、上架補貨、標原價與精選 → 顧客從首頁與導覽進入分類、排序篩選載入更多、搜尋、特價頁 → 購物車與結帳 → 閘道付款成功（真實 webhook 與導回）→ 管理員出貨 → 顧客看到已出貨", async ({
  admin,
  gatewayConsole,
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  // 1. 管理員建立分類並上傳分類圖片；同分類先上架陪襯商品，主流程商品之後上架，才會是最新上架
  await createCategory(admin, CATEGORY);
  await expect(admin.getByRole("status")).toHaveText("已建立分類。");
  await admin.goto("/admin/categories");
  await admin.getByRole("row", { name: new RegExp(CATEGORY.slug) }).getByRole("link", { name: /修改/ }).click();
  const categoryPng = await admin.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 1500; canvas.height = 1000;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#c4321c"; ctx.fillRect(0, 0, 1500, 1000);
    return canvas.toDataURL("image/png").split(",")[1]!;
  });
  await admin.getByLabel("分類圖片（JPEG、PNG 或 WebP，20 MB 以內）").setInputFiles({ name: "category.png", mimeType: "image/png", buffer: Buffer.from(categoryPng, "base64") });
  await admin.getByRole("button", { name: "上傳分類圖片", exact: true }).click();
  await expect(admin.locator("#image-status")).toHaveText("已儲存分類圖片。");
  await seedListedProductsInCategory(admin.context(), CATEGORY.name, FILLERS);

  // 2. 管理員新增商品、選分類、上傳多張圖片、補貨、標原價後上架並標為精選
  await admin.goto("/admin");
  await admin.getByRole("link", { name: "新增商品", exact: true }).click();
  await expect(admin).toHaveURL(`${BASE_URL}/admin/products/new`);
  await admin.getByLabel("名稱", { exact: true }).fill(PRODUCT.name);
  await admin.getByLabel("說明", { exact: true }).fill(PRODUCT.description);
  await admin.getByLabel("單價（新台幣整數元）").fill(PRODUCT.priceTwd);
  await admin.getByRole("button", { name: "新增商品" }).click();
  await expect(admin).toHaveURL(new RegExp(`^${BASE_URL}/admin/products/\\d+\\?saved=created$`));
  await expect(admin.getByRole("status").filter({ hasText: "已新增商品。" })).toHaveText("已新增商品。");
  await assignCategory(admin, PRODUCT.name, CATEGORY.name);

  const productRow = admin.getByRole("row", { name: new RegExp(PRODUCT.name) });
  await productRow.getByLabel(`${PRODUCT.name}的庫存增減量`).fill("+5");
  await productRow.getByRole("button", { name: "調整庫存" }).click();
  await expect(admin.getByRole("status")).toHaveText("已調整庫存。");
  await expect(productRow).toContainText("已下架");
  await productRow.getByRole("button", { name: "重新上架" }).click();
  await expect(admin.getByRole("alert")).toContainText("請先上傳商品圖片");
  await productRow.getByRole("link", { name: "編輯" }).click();
  const png = await admin.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 1600; canvas.height = 1000;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#174ea6"; ctx.fillRect(0, 0, 1600, 1000);
    ctx.fillStyle = "#ffffff"; ctx.font = "160px sans-serif"; ctx.fillText("Storefront", 200, 550);
    return canvas.toDataURL("image/png").split(",")[1]!;
  });
  await admin.getByLabel("商品圖片（JPEG、PNG 或 WebP，20 MB 以內）").setInputFiles({ name: "product.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") });
  // Network/service failure keeps the selection and permits retry, without duplicates.
  await admin.route("**/admin/products/*/images", route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ ok: false, reason: "image_upload_failed" }) }), { times: 1 });
  await admin.getByRole("button", { name: "上傳商品圖片" }).click();
  await expect(admin.getByRole("alert")).toContainText("商品圖片上傳失敗");
  // A response lost AFTER commit must replay the same upload, not consume a second slot.
  await admin.route("**/admin/products/*/images", async route => { const committed = await route.fetch(); expect(committed.status()).toBe(201); await route.abort("failed"); }, { times: 1 });
  await admin.getByRole("button", { name: "上傳商品圖片" }).click();
  await expect(admin.locator("#image-error")).toBeVisible();
  await expect(admin.getByRole("button", { name: "上傳商品圖片", exact: true })).toBeEnabled();
  let uploadRequests = 0;
  admin.on("request", request => { if (request.method() === "POST" && request.url().endsWith("/images")) uploadRequests++; });
  await admin.locator("#image-upload").evaluate(form => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  await expect(admin.locator("#image-status")).toContainText("已上傳商品圖片");
  expect(uploadRequests).toBe(1);
  await expect(admin.locator("#product-images img")).toHaveCount(1);
  await admin.reload();
  await expect(admin.locator("#product-images img")).toHaveCount(1);
  // A second selection uploads multiple files in one browser-resizing batch.
  const additional = await admin.evaluate(() => ["#0f766e", "#9f1239"].map(color => {
    const canvas = document.createElement("canvas"); canvas.width = 1600; canvas.height = 1000;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = color; ctx.fillRect(0, 0, 1600, 1000);
    return canvas.toDataURL("image/png").split(",")[1]!;
  }));
  await admin.getByLabel("商品圖片（JPEG、PNG 或 WebP，20 MB 以內）").setInputFiles(additional.map((data, index) => ({ name: `detail-${index}.png`, mimeType: "image/png", buffer: Buffer.from(data, "base64") })));
  await admin.getByRole("button", { name: "上傳商品圖片", exact: true }).click();
  await expect(admin.locator("#image-status")).toContainText("已上傳商品圖片");
  await expect(admin.locator("#product-images img")).toHaveCount(3);
  await admin.reload();
  await expect(admin.locator("#product-images img")).toHaveCount(3);
  const coverSrc = (await admin.locator("#product-images img").first().getAttribute("src"))!;
  await testInfo.attach("admin-image-upload", { body: await admin.screenshot({ fullPage: true }), contentType: "image/png" });
  // 儲存原價後回到商品管理
  await admin.getByLabel("原價（選填）").fill(PRODUCT.compareAtPriceTwd);
  await admin.getByRole("button", { name: "儲存", exact: true }).click();
  await expect(admin.getByRole("status")).toHaveText("已儲存商品。");
  await admin.getByRole("row", { name: new RegExp(PRODUCT.name) }).getByRole("button", { name: "重新上架" }).click();
  await expect(admin.getByRole("row", { name: new RegExp(PRODUCT.name) })).toContainText("上架中");
  await featureProduct(admin, PRODUCT.name);

  // 3. 顧客從首頁精選、分類方塊與導覽列都能進入分類頁（桌機）
  await page.setViewportSize({ width: 1280, height: 900 });
  const categoryUrl = new RegExp(`/categories/${CATEGORY.slug}$`);
  await page.goto("/");
  const featured = page.getByRole("region", { name: "精選商品" }).getByRole("listitem").filter({ hasText: PRODUCT.name });
  await expectSaleCard(featured);
  await featured.getByRole("link").filter({ has: page.getByRole("heading", { name: PRODUCT.name, exact: true }) }).click();
  await expect(page.getByRole("heading", { level: 1, name: PRODUCT.name })).toBeVisible();
  await page.getByRole("navigation", { name: "麵包屑" }).getByRole("link", { name: CATEGORY.name }).click();
  await expect(page).toHaveURL(categoryUrl);
  await page.goto("/");
  const tile = page.getByRole("region", { name: "選購分類" }).getByRole("link", { name: new RegExp(CATEGORY.name) });
  // 分類圖片是裝飾性的（alt=""），沒有 img 角色
  await expect(tile.locator("img")).toBeVisible();
  await tile.click();
  await expect(page).toHaveURL(categoryUrl);
  await page.goto("/");
  await page.getByRole("navigation", { name: "主要導覽" }).getByRole("link", { name: CATEGORY.name, exact: true }).click();
  await expect(page).toHaveURL(categoryUrl);

  // 4. 分類頁：排序、載入更多、重新整理還原、只看有貨、只看特價
  await expect(page.getByRole("heading", { level: 1, name: CATEGORY.name })).toBeVisible();
  await expect(page.getByText(`共 ${FILLERS.length + 1} 件商品`)).toBeVisible();
  await expect(cards(page).first()).toContainText(PRODUCT.name);
  await sortLink(page, "價格高到低").click();
  await expect(page).toHaveURL(/\?sort=price-desc$/);
  await expect(productCard(page)).toHaveCount(0);
  await page.getByRole("link", { name: "載入更多" }).click();
  await expect(page).toHaveURL(/\?sort=price-desc&page=2$/);
  await expect(page.getByText(`已顯示 ${FILLERS.length + 1} / ${FILLERS.length + 1} 件`)).toBeVisible();
  await expect(cards(page).last()).toContainText(PRODUCT.name);
  await page.reload();
  await expect(sortLink(page, "價格高到低")).toHaveAttribute("aria-current", "true");
  await expect(cards(page)).toHaveCount(FILLERS.length + 1);
  await expectSaleCard(productCard(page));
  await page.getByRole("checkbox", { name: "只看有貨" }).click();
  await expect(page).toHaveURL(/\?sort=price-desc&instock=1$/);
  await expect(page.getByText(`已顯示 ${IN_STOCK_COUNT} / ${IN_STOCK_COUNT} 件`)).toBeVisible();
  await expect(page.getByText("已售完")).toHaveCount(0);
  await page.getByRole("checkbox", { name: "只看特價" }).click();
  await expect(page).toHaveURL(/\?sort=price-desc&instock=1&sale=1$/);
  await expect(cards(page)).toHaveCount(1);
  await expectSaleCard(productCard(page));
  await page.reload();
  await expect(page.getByRole("checkbox", { name: "只看有貨" })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "只看特價" })).toBeChecked();
  await expect(cards(page)).toHaveCount(1);
  await audit(page, testInfo, "category-filtered-desktop");

  // 5. 搜尋（不分大小寫）並從結果進入詳情頁
  await page.getByRole("banner").getByRole("button", { name: "搜尋", exact: true }).click();
  await page.getByRole("dialog", { name: "搜尋" }).getByRole("searchbox", { name: "搜尋商品" }).fill("e2e 測試商品");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/search\?q=/);
  await expect(page.getByRole("heading", { level: 1, name: "搜尋：e2e 測試商品" })).toBeVisible();
  await expectSaleCard(productCard(page));
  await audit(page, testInfo, "search-results-desktop");
  await productCard(page).getByRole("link").first().click();
  await expect(page.getByRole("heading", { level: 1, name: PRODUCT.name })).toBeVisible();

  // 6. 導覽列的特價頁看得到這件商品
  await page.getByRole("navigation", { name: "主要導覽" }).getByRole("link", { name: "特價", exact: true }).click();
  await expect(page).toHaveURL(/\/sale$/);
  await expectSaleCard(productCard(page));
  await audit(page, testInfo, "sale-desktop");

  // 7. 顧客以直接寫入 D1 的 session 登入（ADR 0013）
  await page.context().addCookies([memberSessionCookie()]);

  // 8. 從全部商品進入詳情、圖庫、加入購物車 → 購物車頁 → 結帳 → 訂單頁待付款
  await page.goto("/products");
  const productItem = page.getByRole("listitem").filter({ hasText: PRODUCT.name });
  const cover = productItem.getByRole("img", { name: `${PRODUCT.name}的封面` });
  await expect(cover).toBeVisible();
  await expect.poll(() => cover.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  await expect(cover).toHaveAttribute("srcset", /320w.*640w.*1280w/);
  await expect(cover).toHaveAttribute("width", "1280");
  const coverSrcset = (await cover.getAttribute("srcset"))!;
  const imageResponse = await page.request.get((await cover.getAttribute("src"))!);
  expect(imageResponse.headers()["cache-control"]).toContain("immutable");
  expect(imageResponse.headers()["content-type"]).toBe("image/webp");
  for (const width of [320, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await testInfo.attach(`catalog-image-${width}`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await audit(page, testInfo, "populated-products-mobile");
  const detailLink = productItem.getByRole("link").filter({ has: page.getByRole("heading", { name: PRODUCT.name, exact: true }) });
  await tabTo(page, detailLink);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/products\/\d+$/);
  await expect(page.locator(".gallery-slide img")).toHaveCount(3);
  await expect(page.locator(".gallery-slide img").first()).toHaveAttribute("src", coverSrc);
  const gallery = page.getByRole("group", { name: "商品圖片瀏覽", exact: true });
  await tabTo(page, gallery);
  await page.keyboard.press("ArrowRight");
  const thumbs = page.getByRole("group", { name: "選擇商品圖片" }).getByRole("button");
  await expect(thumbs.nth(1)).toHaveAttribute("aria-current", "true");
  await page.keyboard.press("End");
  await expect(thumbs.nth(2)).toHaveAttribute("aria-current", "true");
  await page.keyboard.press("Home");
  await expect(thumbs.first()).toHaveAttribute("aria-current", "true");
  await audit(page, testInfo, "populated-detail-mobile");
  const information = page.getByRole("region", { name: "商品資訊" });
  const add = information.getByRole("button", { name: "加入購物車", exact: true });
  await tabTo(page, add);
  await page.keyboard.press("Enter");
  await expect(information.getByRole("status")).toHaveText("已加入購物車（目前 1 件）");
  await expect(add).toBeFocused();
  await expect(page.locator("#cart-count")).toHaveText("1");
  await testInfo.attach("keyboard-add-toast", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });

  await page.goto("/cart");
  await expect(page.getByRole("listitem").filter({ hasText: PRODUCT.name })).toBeVisible();
  const cartSummary = page.getByRole("complementary").filter({ hasText: "訂單摘要" });
  await expect(cartSummary).toContainText(/總金額\s*NT\$ 1,200/);
  for (const text of ["新台幣", "含稅", "免運"]) await expect(cartSummary).toContainText(text);
  await expect(page.getByRole("img", { name: `${PRODUCT.name}的封面`, exact: true })).toHaveAttribute("src", coverSrc);
  await audit(page, testInfo, "populated-cart-mobile");
  await page.getByRole("link", { name: "前往結帳" }).click();

  await expect(page).toHaveURL(/\/checkout$/);
  await page.getByLabel("收件人姓名").fill("E2E 收件人");
  await page.getByLabel("收件人電話").fill("0912345678");
  await page.getByLabel("收件地址").fill("台北市中正區（E2E 示意地址）");
  await audit(page, testInfo, "populated-checkout-mobile");
  await page.getByRole("button", { name: "送出訂單" }).click();

  await expect(page).toHaveURL(/\/orders\/\d+\?placed=1$/);
  const orderPath = new URL(page.url()).pathname;
  const orderId = orderPath.split("/").pop()!;
  await expect(page.getByText("訂單狀態：待付款")).toBeVisible();

  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  // 9. 前往付款 → 模擬閘道付款頁 → 成功＋立即回呼 → 導回訂單頁已付款
  await page.getByRole("button", { name: "前往付款" }).click();
  await expect(page).toHaveURL(new RegExp(`^${GATEWAY_URL}/pay/`));
  const paymentId = new URL(page.url()).pathname.split("/").pop()!;
  await page.getByRole("radio", { name: "成功" }).check();
  await page.getByRole("radio", { name: "立即回呼" }).check();

  // 閘道先同步送出簽章 webhook，再 303 導回 /orders/:id/payment-return（App 向閘道查詢）→ 訂單頁
  const paymentReturn = page.waitForResponse(
    (response) => response.url() === `${BASE_URL}${orderPath}/payment-return?paymentId=${paymentId}` && response.status() === 303,
  );
  await page.getByRole("button", { name: "送出" }).click();
  await paymentReturn;

  await expect(page).toHaveURL(`${BASE_URL}${orderPath}`);
  await expect(page.getByText("訂單狀態：已付款")).toBeVisible();
  await expect(page.getByText("已收到付款，訂單已付款。")).toBeVisible();

  // webhook 確實被 Web 驗簽並回 2xx：閘道主控頁「這一筆付款」的投遞紀錄是 HTTP 200（驗簽失敗會是 401）
  await gatewayConsole.goto(`${GATEWAY_URL}/console`);
  const paymentSection = gatewayConsole.locator("section").filter({ has: gatewayConsole.locator("code", { hasText: paymentId }) });
  await expect(paymentSection).toContainText("payment.succeeded");
  await expect(paymentSection).toContainText("HTTP 200");

  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  // 10. 管理員在 /admin/orders 看到已付款 → 明細 → 出貨
  await admin.goto("/admin/orders");
  const orderRow = admin.getByRole("row", { name: new RegExp(`#${orderId}\\b`) });
  await expect(orderRow).toContainText(MEMBER.email);
  await expect(orderRow).toContainText("已付款");
  await orderRow.getByRole("link", { name: `#${orderId}` }).click();

  await expect(admin).toHaveURL(`${BASE_URL}/admin/orders/${orderId}`);
  await admin.getByLabel("物流單號（可留空）").fill(TRACKING_NUMBER);
  await admin.getByRole("button", { name: "標為已出貨" }).click();
  await expect(admin.getByRole("status")).toHaveText("已標為已出貨。");
  await expect(admin.getByText(`物流單號：${TRACKING_NUMBER}`)).toBeVisible();

  // 11. 顧客訂單列表與詳情都顯示目前封面、已出貨狀態及物流單號
  await page.goto("/orders");
  const customerOrder = page.getByRole("listitem").filter({ has: page.getByRole("link", { name: new RegExp(`#${orderId}\\b`) }) });
  await expect(customerOrder).toContainText("已出貨");
  await expect(customerOrder.getByRole("img", { name: `${PRODUCT.name}的封面`, exact: true })).toHaveAttribute("srcset", coverSrcset);
  await audit(page, testInfo, "populated-orders-mobile");
  await page.goto(orderPath);
  await expect(page.getByText("訂單狀態：已出貨")).toBeVisible();
  await expect(page.getByText(`物流單號：${TRACKING_NUMBER}`)).toBeVisible();
  await expect(page.getByRole("img", { name: `${PRODUCT.name}的封面`, exact: true })).toHaveAttribute("srcset", coverSrcset);
  for (const width of [320, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await testInfo.attach(`order-${width}`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of ["/about", "/faq", "/returns", "/not-a-real-page"]) {
    expect((await page.goto(path))!.status()).toBe(path === "/not-a-real-page" ? 404 : 200);
    await audit(page, testInfo, `integrated-${path.slice(1)}`);
  }
});
