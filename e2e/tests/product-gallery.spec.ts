import { expect, test, type Page } from "@playwright/test";
import { adminAccessHeaders } from "../harness/admin-access";
import { assignSharedCategory } from "../harness/admin-categories";
import { BASE_URL } from "../harness/constants";
import { gotoProductList } from "../harness/admin-list";
import { analyzeWhenSettled } from "../harness/axe";

async function createProduct(page: Page, name: string) {
  await page.goto("/admin/products/new");
  await page.getByLabel("名稱", { exact: true }).fill(name);
  await page.getByLabel("單價（新台幣整數元）").fill("350");
  await page.getByRole("button", { name: "新增商品", exact: true }).click();
  await assignSharedCategory(page, name);
  await page.getByRole("row").filter({ hasText: name }).getByRole("link", { name: "編輯" }).click();
  await expect(page.getByRole("button", { name: "上傳商品圖片", exact: true })).toBeEnabled();
}
async function files(page: Page, count: number) {
  const pngs = await page.evaluate(count => Array.from({ length: count }, (_, index) => {
    const canvas = document.createElement("canvas"); canvas.width = 400; canvas.height = 300;
    const ctx = canvas.getContext("2d")!; ctx.fillStyle = ["#164e63", "#9f1239", "#3f6212"][index % 3]!;
    ctx.fillRect(0, 0, 400, 300); ctx.fillStyle = "white"; ctx.font = "60px sans-serif"; ctx.fillText(String(index + 1), 150, 180);
    return canvas.toDataURL("image/png").split(",")[1]!;
  }), count);
  return pngs.map((png, index) => ({ name: `gallery-${index + 1}.png`, mimeType: "image/png", buffer: Buffer.from(png, "base64") }));
}
test("gallery multi-upload, keyboard/drag reorder, cover and last-image safety", async ({ browser }, testInfo) => {
  test.setTimeout(90_000);
  const context = await browser.newContext({ baseURL: BASE_URL, extraHTTPHeaders: adminAccessHeaders() });
  const page = await context.newPage(); page.on("dialog", dialog => void dialog.accept());
  const name = "圖庫管理端對端商品";
  try {
    await createProduct(page, name);
    const editPath = new URL(page.url()).pathname;
    await page.getByLabel("商品圖片（JPEG、PNG 或 WebP，20 MB 以內）").setInputFiles(await files(page, 3));
    await page.getByRole("button", { name: "上傳商品圖片", exact: true }).click();
    await expect(page.locator("#image-status")).toContainText("已上傳商品圖片");
    const items = page.locator("#product-images li"); await expect(items).toHaveCount(3);
    const originals = await items.evaluateAll(items => items.map(item => (item as HTMLElement).dataset.imageId));
    // Keyboard-only ordering with a retained focus target after rerender.
    await page.getByRole("button", { name: "上移商品圖片 2", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(items.first()).toHaveAttribute("data-image-id", originals[1]!);
    await expect(page.locator("#product-images button:focus")).toHaveCount(1);
    // 排序儲存中圖片不可拖曳（busy）：等儲存完成再拖，否則拖曳會被忽略
    await expect(page.locator("#image-status")).toContainText("已儲存商品圖片順序");
    await expect(items.nth(2)).toHaveAttribute("draggable", "true");
    // 以 HTML5 拖放事件驅動：瀏覽器自動化的滑鼠拖曳是否真的觸發 dragstart 取決於版面與時序（並行時約三成沒有觸發），
    // 事件序列本身（dragstart → dragover → drop → dragend）才是這個功能的介面
    const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
    await items.nth(2).dispatchEvent("dragstart", { dataTransfer });
    await items.first().dispatchEvent("dragover", { dataTransfer });
    await items.first().dispatchEvent("drop", { dataTransfer });
    await items.nth(2).dispatchEvent("dragend", { dataTransfer });
    await expect(items.first()).toHaveAttribute("data-image-id", originals[2]!);
    await page.reload(); await expect(items.first()).toHaveAttribute("data-image-id", originals[2]!);
    const coverSrc = await items.first().locator("img").getAttribute("src");
    expect((await analyzeWhenSettled(page)).violations).toEqual([]);
    await page.setViewportSize({ width: 320, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await testInfo.attach("admin-gallery-mobile", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
    await gotoProductList(page, name);
    const row = page.getByRole("row").filter({ hasText: name });
    await expect(row.getByRole("img", { name: name })).toHaveAttribute("src", coverSrc!);
    await row.getByRole("button", { name: "重新上架" }).click();
    await page.goto(editPath);
    for (let n = 0; n < 2; n++) {
      await page.getByRole("button", { name: "刪除商品圖片 1", exact: true }).click();
      await expect(items).toHaveCount(2 - n);
    }
    await page.getByRole("button", { name: "刪除商品圖片 1", exact: true }).click();
    await expect(page.locator("#image-error")).toContainText("至少需要一張");
    await page.reload(); await expect(items).toHaveCount(1);
    await gotoProductList(page, name); await row.getByRole("button", { name: "下架", exact: true }).click();
    await page.goto(editPath); await page.getByRole("button", { name: "刪除商品圖片 1", exact: true }).click();
    await expect(items).toHaveCount(0); await page.reload(); await expect(items).toHaveCount(0);
  } finally { await context.close(); }
});
test("multi-upload retains completed files on interruption, retries remaining files, and rejects a ninth image", async ({ browser }, testInfo) => {
  test.setTimeout(90_000);
  const context = await browser.newContext({ baseURL: BASE_URL, extraHTTPHeaders: adminAccessHeaders() });
  const page = await context.newPage();
  try {
    await createProduct(page, "圖庫上限與重試商品");
    await page.getByLabel("商品圖片（JPEG、PNG 或 WebP，20 MB 以內）").setInputFiles(await files(page, 9));
    let requests = 0;
    await page.route("**/admin/products/*/images", async route => {
      requests++;
      if (requests === 2) await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ ok: false, reason: "image_upload_failed" }) });
      else await route.continue();
    });
    await page.getByRole("button", { name: "上傳商品圖片", exact: true }).click();
    await expect(page.locator("#image-error")).toContainText("上傳失敗");
    await expect(page.locator("#product-images li")).toHaveCount(1);
    await page.getByRole("button", { name: "上傳商品圖片", exact: true }).click();
    await expect(page.locator("#image-error")).toContainText("最多 8 張");
    await expect(page.locator("#product-images li")).toHaveCount(8);
    await page.reload(); await expect(page.locator("#product-images li")).toHaveCount(8);
    await testInfo.attach("admin-gallery-eight-images", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
  } finally { await context.close(); }
});

test("upload waits for client readiness and reports failure before reconciliation completes", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: BASE_URL, extraHTTPHeaders: adminAccessHeaders() });
  const page = await context.newPage();
  let releaseModule = () => {};
  let releaseRead = () => {};
  try {
    await createProduct(page, "圖庫載入與失敗回饋商品");
    const editPath = new URL(page.url()).pathname;
    const moduleGate = new Promise<void>(resolve => { releaseModule = resolve; });
    await page.route("**/_astro/_id_.astro_astro_type_script_index_0_lang.*.js", async route => { await moduleGate; await route.continue(); }, { times: 1 });
    await page.goto(editPath, { waitUntil: "commit" });
    const input = page.getByLabel("商品圖片（JPEG、PNG 或 WebP，20 MB 以內）");
    const upload = page.getByRole("button", { name: "上傳商品圖片", exact: true });
    await expect(input).toBeDisabled();
    await expect(upload).toBeDisabled();
    releaseModule();
    await expect(input).toBeEnabled();
    await expect(upload).toBeEnabled();
    await input.setInputFiles(await files(page, 1));
    const readGate = new Promise<void>(resolve => { releaseRead = resolve; });
    await page.route("**/admin/products/*/gallery", async route => { await readGate; await route.continue(); }, { times: 1 });
    await page.route("**/admin/products/*/images", async route => {
      const committed = await route.fetch(); expect(committed.status()).toBe(201);
      await route.abort("failed");
    }, { times: 1 });
    await upload.click();
    // This assertion must succeed while the reconciliation response is still held.
    await expect(page.locator("#image-error")).toBeVisible();
    releaseRead();
    await expect(upload).toBeEnabled();
    await expect(page.locator("#product-images li")).toHaveCount(1);
    await upload.click();
    await expect(page.locator("#image-status")).toContainText("已上傳商品圖片");
    await expect(page.locator("#product-images li")).toHaveCount(1);
    await page.reload();
    await expect(page.locator("#product-images li")).toHaveCount(1);
  } finally { releaseModule(); releaseRead(); await context.close(); }
});
