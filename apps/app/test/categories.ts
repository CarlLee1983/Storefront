import { exports } from "cloudflare:workers";

const app = exports.default;

/** 建立分類並回傳它的 id；分類本身的行為由 categories.test.ts 驗證。 */
export async function createCategory(jwt: string, slug = "living", name = "客廳", description = "沙發、茶几與落地燈"): Promise<number> {
  const created = await app.createCategory(jwt, { slug, name, description });
  if (!created.ok) throw new Error(`建立分類失敗：${created.reason}`);
  return created.data.id;
}

/** 把商品歸到指定分類，其餘欄位維持原值；商品設定分類的行為由 product-category.test.ts 驗證。 */
export async function assignCategory(jwt: string, id: number, categoryId: number): Promise<void> {
  const found = await app.getProductForAdmin(jwt, { id });
  if (!found.ok) throw new Error(`讀取商品失敗：${found.reason}`);
  const { name, description, priceTwd } = found.data;
  const updated = await app.updateProduct(jwt, { id, name, description, priceTwd, categoryId });
  if (!updated.ok) throw new Error(`設定分類失敗：${updated.reason}`);
}

/** 讓商品有分類：已經有就不動，沒有就歸到「default」分類（還沒有就先建立）；給只關心上架流程、不在意分類的測試用。 */
export async function assignDefaultCategory(jwt: string, id: number): Promise<void> {
  const product = await app.getProductForAdmin(jwt, { id });
  if (!product.ok) throw new Error(`讀取商品失敗：${product.reason}`);
  if (product.data.category) return;
  const listed = await app.listCategoriesForAdmin(jwt);
  if (!listed.ok) throw new Error(`讀取分類失敗：${listed.reason}`);
  const categoryId = listed.data.find((category) => category.slug === "default")?.id ?? await createCategory(jwt, "default", "預設分類", "測試用的預設分類");
  await assignCategory(jwt, id, categoryId);
}
