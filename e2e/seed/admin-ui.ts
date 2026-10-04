import { expect, type Locator, type Page } from "@playwright/test";
import type { DemoCategory, DemoProduct } from "./catalog";

/**
 * 以管理員的身分操作後台頁面（與真人點的是同一組表單與上傳流程：瀏覽器縮放、送到 Web、經 App 驗證、寫入 R2）。
 * 每個動作都從乾淨的頁面開始，送出後等待後台的成功訊息；後台回錯誤時把錯誤訊息原樣拋出。
 */

const ACTION_TIMEOUT_MS = 30_000;
/** 多張大圖在瀏覽器縮放再上傳到 preview，比一般表單慢得多。 */
const UPLOAD_TIMEOUT_MS = 180_000;

export interface AdminCategory {
  id: string;
  slug: string;
  name: string;
  hasImage: boolean;
}

export interface AdminProduct {
  id: string;
  name: string;
  onHand: number;
  listed: boolean;
  featured: boolean;
}

/** 開啟後台頁面；沒有權限（Access 未登入或 JWT 不對）時直接失敗，不往下寫。 */
export async function openAdmin(page: Page, path: string) {
  const response = await page.goto(path);
  const denied = page.getByText("沒有權限：請確認已通過 Cloudflare Access 登入。");
  if (await denied.isVisible()) throw new Error(`沒有後台權限（${page.url()}）`);
  return response;
}

/** 寫入前確認對方真的是本站後台：本機埠可能被其他專案的 dev server 佔用。 */
export async function assertStorefrontAdmin(page: Page, expectedBaseUrl: string) {
  const response = await openAdmin(page, "/admin");
  const expected = new URL("/admin", expectedBaseUrl);
  const actual = new URL(page.url());
  const create = page.getByRole("main").getByRole("link", { name: "新增商品", exact: true });
  if (!response?.ok() || actual.origin !== expected.origin || actual.pathname !== expected.pathname
    || !(await page.getByRole("heading", { level: 1, name: "商品管理", exact: true }).isVisible())
    || !(await create.isVisible()) || await create.getAttribute("href") !== "/admin/products/new") {
    throw new Error(`${page.url()} 不是 Storefront 的商品管理頁，停止 seed。`);
  }
  const openMenu = page.getByRole("button", { name: "開啟後台選單", exact: true });
  try {
    if (await openMenu.isVisible()) await openMenu.click();
    const current = page.getByRole("navigation", { name: "後台導覽" }).getByRole("link", { name: "商品管理", exact: true });
    if (!(await current.isVisible()) || await current.getAttribute("aria-current") !== "page"
      || await current.getAttribute("href") !== "/admin") {
      throw new Error(`${page.url()} 不是 Storefront 的商品管理頁，停止 seed。`);
    }
  } finally {
    const closeMenu = page.getByRole("dialog", { name: "後台選單" }).getByRole("button", { name: "關閉後台選單", exact: true });
    if (await closeMenu.isVisible()) await closeMenu.click();
  }
}

async function submitAndExpect(page: Page, button: Locator, success: string) {
  await button.click();
  const alert = page.getByRole("alert").filter({ hasText: /\S/ });
  await expect(page.getByRole("status").filter({ hasText: success }).or(alert).first()).toBeVisible({ timeout: ACTION_TIMEOUT_MS });
  if (await alert.first().isVisible()) throw new Error(`後台回報錯誤：${await alert.first().innerText()}`);
}

/** 後台資料表的一列：依表頭取欄位文字，連結指向該列的編輯頁。 */
interface TableRow {
  id: string;
  cells: Record<string, string>;
  hasImage: boolean;
}

/** 讀出後台資料表（以 aria-label 找到）的每一列；依表頭名稱取欄位，不依欄位順序。 */
async function readTable(page: Page, tableLabel: string, linkPrefix: string): Promise<TableRow[]> {
  return page.evaluate(({ tableLabel, linkPrefix }) => {
    const table = document.querySelector(`[aria-label="${tableLabel}"] table`);
    if (!table) return [];
    const headers = [...table.querySelectorAll("thead th")].map((th) => th.textContent?.trim() ?? "");
    return [...table.querySelectorAll("tbody tr")].map((tr) => ({
      id: tr.querySelector(`a[href^="${linkPrefix}"]`)?.getAttribute("href")?.split("/").pop() ?? "",
      cells: Object.fromEntries(headers.map((header, index) => [header, tr.children[index]?.textContent?.trim() ?? ""])),
      hasImage: tr.querySelector("img") !== null,
    }));
  }, { tableLabel, linkPrefix });
}

function requireCell(row: TableRow, header: string): string {
  const value = row.cells[header];
  if (value === undefined) throw new Error(`後台資料表缺少「${header}」欄，後台版面可能已改變`);
  return value;
}

export async function listCategories(page: Page): Promise<AdminCategory[]> {
  await openAdmin(page, "/admin/categories");
  return (await readTable(page, "分類資料表", "/admin/categories/")).map((row) => ({
    id: row.id,
    slug: requireCell(row, "代稱"),
    name: requireCell(row, "名稱"),
    hasImage: row.hasImage,
  }));
}

export async function createCategory(page: Page, category: DemoCategory) {
  await openAdmin(page, "/admin/categories");
  await page.getByLabel("分類名稱").fill(category.name);
  await page.getByLabel("分類說明").fill(category.blurb);
  await page.getByLabel("網址代稱").fill(category.slug);
  await submitAndExpect(page, page.getByRole("button", { name: "建立分類" }), "已建立分類。");
}

export async function uploadCategoryImage(page: Page, categoryId: string, file: string) {
  await openAdmin(page, `/admin/categories/${categoryId}`);
  const input = page.getByLabel("分類圖片（JPEG、PNG 或 WebP，20 MB 以內）");
  await expect(input).toBeEnabled();
  await input.setInputFiles(file);
  await page.getByRole("button", { name: "上傳分類圖片" }).click();
  await expectUploaded(page, "已儲存分類圖片。");
}

export async function listProducts(page: Page): Promise<AdminProduct[]> {
  await openAdmin(page, "/admin");
  return (await readTable(page, "管理資料表", "/admin/products/")).map((row) => {
    const name = requireCell(row, "名稱");
    const onHand = Number(requireCell(row, "在庫數"));
    if (!Number.isInteger(onHand)) throw new Error(`讀不到「${name}」的在庫數`);
    return {
      id: row.id,
      name,
      onHand,
      listed: requireCell(row, "狀態") === "上架中",
      // 精選欄位是「精選」或「—」，後面接著切換按鈕的文字
      featured: requireCell(row, "精選").startsWith("精選"),
    };
  });
}

export async function createProduct(page: Page, product: DemoProduct) {
  await openAdmin(page, "/admin/products/new");
  const form = page.locator("form").filter({ has: page.getByRole("button", { name: "新增商品", exact: true }) });
  await form.getByLabel("名稱", { exact: true }).fill(product.name);
  await form.getByLabel("說明", { exact: true }).fill(product.description);
  await form.getByLabel("單價（新台幣整數元）").fill(String(product.priceTwd));
  await submitAndExpect(page, form.getByRole("button", { name: "新增商品", exact: true }), "已新增商品。");
  await expect(page).toHaveURL(/\/admin\/products\/[1-9]\d*\?saved=created$/);
}

/**
 * 在商品編輯頁把說明、售價、原價與分類對齊清單（有差異才儲存），再補傳缺少的商品圖片。
 * 圖片依序上傳，中斷時已上傳的必定是清單的前幾張，所以只補傳後面缺的；回傳這次上傳的張數。
 */
export async function syncProductDetails(page: Page, id: string, product: DemoProduct, categoryName: string): Promise<{ saved: boolean; uploaded: number }> {
  await openAdmin(page, `/admin/products/${id}`);
  const form = page.locator("form").filter({ has: page.getByRole("button", { name: "儲存變更", exact: true }) });
  // 以欄位 name 定位：包住 textarea 的 label，其無障礙名稱會連同目前的內容一起計算，精確比對標籤文字會失敗
  const fields: Array<[Locator, string]> = [
    [form.locator('[name="description"]'), product.description],
    [form.locator('[name="priceTwd"]'), String(product.priceTwd)],
    [form.locator('[name="compareAtPriceTwd"]'), product.compareAtPriceTwd === null ? "" : String(product.compareAtPriceTwd)],
  ];
  const category = form.getByLabel("分類", { exact: true });
  const currentCategory = (await category.locator("option:checked").textContent())?.trim();
  let saved = currentCategory !== categoryName;
  for (const [field, value] of fields) saved ||= (await field.inputValue()) !== value;
  if (saved) {
    for (const [field, value] of fields) await field.fill(value);
    await category.selectOption({ label: categoryName });
    await submitAndExpect(page, form.getByRole("button", { name: "儲存變更", exact: true }), "已儲存商品。");
    await openAdmin(page, `/admin/products/${id}`);
  }

  const existing = await page.locator("#product-images > li").count();
  const missing = product.imageFiles.slice(existing);
  if (missing.length > 0) {
    const input = page.getByLabel("商品圖片（JPEG、PNG 或 WebP，20 MB 以內）");
    await expect(input).toBeEnabled();
    await input.setInputFiles(missing);
    await page.getByRole("button", { name: "上傳商品圖片", exact: true }).click();
    await expectUploaded(page, "已上傳商品圖片。可以回商品管理上架。");
  }
  return { saved, uploaded: missing.length };
}

async function expectUploaded(page: Page, success: string) {
  const error = page.locator("#image-error");
  await expect(page.locator("#image-status").filter({ hasText: success }).or(error).first()).toBeVisible({ timeout: UPLOAD_TIMEOUT_MS });
  if (await error.isVisible()) throw new Error(`圖片上傳失敗：${await error.innerText()}`);
}

function productRow(page: Page, name: string) {
  return page.getByRole("row").filter({ has: page.getByRole("cell", { name, exact: true }) });
}

/** 庫存只能以增減量調整，並須填寫原因（寫進庫存流水）。 */
export async function adjustStock(page: Page, name: string, delta: number, reason = "示範資料補貨") {
  await openAdmin(page, "/admin");
  const row = productRow(page, name);
  await row.getByLabel(`${name}的庫存增減量`).fill(delta > 0 ? `+${delta}` : String(delta));
  await row.getByLabel(`${name}的庫存調整原因`).fill(reason);
  await submitAndExpect(page, row.getByRole("button", { name: "調整庫存" }), "已調整庫存。");
}

export async function setFeatured(page: Page, name: string, featured: boolean) {
  await openAdmin(page, "/admin");
  const label = featured ? "標為精選" : "取消精選";
  await submitAndExpect(page, productRow(page, name).getByRole("button", { name: `${label}：${name}` }), featured ? "已標為精選商品。" : "已取消精選。");
}

export async function relist(page: Page, name: string) {
  await openAdmin(page, "/admin");
  await submitAndExpect(page, productRow(page, name).getByRole("button", { name: "重新上架", exact: true }), "已重新上架商品。");
}
