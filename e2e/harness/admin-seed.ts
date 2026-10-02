import { expect, type APIRequestContext, type BrowserContext } from "@playwright/test";
import { BASE_URL } from "./constants";

const WIDTHS = [320, 640, 1280] as const;

/** 在瀏覽器裡畫一張 4:3 的純色圖並編成 WebP（App 會驗證 WebP 容器與實際尺寸，不能塞假檔）；各尺寸只做一次，所有商品共用。 */
async function renderCovers(browserContext: BrowserContext): Promise<Array<{ width: number; height: number; bytes: Buffer }>> {
  const page = await browserContext.newPage();
  try {
    return await Promise.all(WIDTHS.map(async (width) => {
      const height = width * 3 / 4;
      const base64 = await page.evaluate(async ({ width, height }) => {
        const canvas = document.createElement("canvas");
        canvas.width = width; canvas.height = height;
        const context = canvas.getContext("2d")!;
        context.fillStyle = "#e5d8c5"; context.fillRect(0, 0, width, height);
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp"));
        if (!blob || blob.type !== "image/webp") throw new Error("瀏覽器無法編碼 WebP");
        return btoa(String.fromCharCode(...new Uint8Array(await blob.arrayBuffer())));
      }, { width, height });
      return { width, height, bytes: Buffer.from(base64, "base64") };
    }));
  } finally { await page.close(); }
}

export interface SeedProduct {
  name: string;
  priceTwd: number;
  /** 在庫數；0 表示已售完。 */
  stock: number;
}

/** 表單 POST 要帶同源的 Origin（Astro 的 CSRF 檢查）；不跟隨轉址，成功是 303。 */
async function post(request: APIRequestContext, path: string, form: Record<string, string>) {
  const response = await request.post(path, { form, headers: { origin: BASE_URL }, maxRedirects: 0 });
  expect(response.status(), `${path} ${JSON.stringify(form)}`).toBe(303);
}

/** 以管理後台的表單與上傳端點（不開瀏覽器頁面）快速建立分類與上架商品，回傳商品編號，供大量資料的 E2E 使用。 */
export async function seedListedProducts(
  adminContext: BrowserContext,
  category: { slug: string; name: string; description: string },
  products: SeedProduct[],
): Promise<number[]> {
  await post(adminContext.request, "/admin/categories", { intent: "create-category", categoryName: category.name, categoryDescription: category.description, categorySlug: category.slug });
  return seedListedProductsInCategory(adminContext, category.name, products);
}

/** 同 seedListedProducts，但分類已經存在（例如測試自己在後台建立）：商品直接放進名稱為 `categoryName` 的分類。 */
export async function seedListedProductsInCategory(adminContext: BrowserContext, categoryName: string, products: SeedProduct[]): Promise<number[]> {
  const admin = adminContext.request;
  const covers = await renderCovers(adminContext);
  // 依序新增，編號才會跟著名稱順序遞增
  for (const { name, priceTwd } of products) await post(admin, "/admin/products/new", { name, description: `${name}的說明`, priceTwd: String(priceTwd) });

  let html = "";
  for (let page = 1; page <= 20; page++) { const part = await (await admin.get(`/admin?page=${page}`)).text(); html += part; if (!part.includes(`page=${page + 1}`)) break; }
  // 商品編號用在編輯頁與圖片上傳，庫存調整則以預設變體為單位（清單每列的庫存表單帶著 variantId）
  const rows = products.map(({ name }) => {
    const match = new RegExp(`<a href="/admin/products/(\\d+)"[^>]*>${name}</a>[\\s\\S]*?name="variantId" value="(\\d+)"`).exec(html);
    if (!match) throw new Error(`後台清單找不到剛建立的商品：${name}`);
    return { id: match[1]!, variantId: match[2]! };
  });
  const ids = rows.map(({ id }) => id);

  // 分類編號只出現在商品編輯頁的下拉選單裡
  const editPage = await (await admin.get(`/admin/products/${ids[0]}`)).text();
  const categoryId = new RegExp(`<option value="(\\d+)"[^>]*>${categoryName}</option>`).exec(editPage)?.[1];
  if (!categoryId) throw new Error(`商品編輯頁找不到分類：${categoryName}`);

  await Promise.all(ids.map(async (id, index) => {
    const { name, priceTwd, stock } = products[index]!;
    await post(admin, `/admin/products/${id}`, { name, description: `${name}的說明`, priceTwd: String(priceTwd), categoryId });
    const upload = await admin.post(`/admin/products/${id}/images`, {
      headers: { origin: BASE_URL },
      multipart: {
        uploadId: crypto.randomUUID(),
        ...Object.fromEntries(covers.flatMap(({ width, height, bytes }) => [
          [`image-${width}`, { name: `${width}.webp`, mimeType: "image/webp", buffer: bytes }],
          [`height-${width}`, String(height)],
        ])),
      },
    });
    expect(upload.status(), `上傳 ${name} 的封面`).toBe(201);
    if (stock > 0) await post(admin, "/admin", { intent: "adjust-stock", variantId: rows[index]!.variantId, delta: `+${stock}`, reason: "E2E 補貨" });
  }));

  // 依序上架：上架時間才會跟著名稱順序遞增
  for (const id of ids) await post(admin, "/admin", { intent: "relist", id });
  return ids.map(Number);
}

/** 上架商品的預設變體編號（讀商品頁上加入購物車表單的 data-variant-id）；購物車與結帳以變體為單位，直接寫入購物車的測試需要它。 */
export async function defaultVariantIds(request: APIRequestContext, productIds: number[]): Promise<number[]> {
  return Promise.all(productIds.map(async (id) => {
    const html = await (await request.get(`/products/${id}`)).text();
    const variantId = /data-variant-id="(\d+)"/.exec(html)?.[1];
    if (!variantId) throw new Error(`商品頁找不到預設變體編號：${id}`);
    return Number(variantId);
  }));
}

/** 依序把商品標為精選（走後台清單的表單，不開瀏覽器頁面）；精選時間跟著傳入順序遞增。 */
export async function featureProducts(admin: APIRequestContext, ids: number[]) {
  for (const id of ids) await post(admin, "/admin", { intent: "feature", id: String(id) });
}

/**
 * 下架後台清單中名稱以 `prefix` 開頭、且仍上架中的商品。依名稱前綴找，所以即使建立到一半失敗（拿不到編號）也能清乾淨；
 * E2E 共用同一份資料庫，大量資料用完要撤掉。
 */
export async function unlistProductsByPrefix(admin: APIRequestContext, prefix: string) {
  const html = await (await admin.get("/admin")).text();
  const ids = html.split("<tr").filter((row) => new RegExp(`<td[^>]*>${prefix}[^<]*</td>`).test(row) && row.includes("上架中"))
    .map((row) => /href="\/admin\/products\/(\d+)"/.exec(row)?.[1]).filter((id): id is string => id !== undefined);
  await Promise.all(ids.map((id) => post(admin, "/admin", { intent: "unlist", id })));
}
