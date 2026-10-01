import { exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { mintAccessJwt } from "./access";
import { assignCategory, createCategory } from "./categories";
import { setNow } from "./clock";
import { resetDb } from "./db";
import { imageVariants, uploadAndList } from "./images";

const app = exports.default;

async function createMug(jwt: string, name = "馬克杯") {
  const created = await app.createProduct(jwt, { name, description: "350ml 陶瓷杯", priceTwd: 320 });
  if (!created.ok) throw new Error("新增商品失敗");
  return created.data.id;
}

async function addImage(jwt: string, id: number) {
  const added = await app.addProductImage(jwt, { id, uploadId: crypto.randomUUID(), variants: imageVariants() });
  if (!added.ok) throw new Error(`商品圖片上傳失敗：${added.reason}`);
}

const mugInput = (id: number, categoryId?: number | null) => ({ id, name: "馬克杯", description: "350ml 陶瓷杯", priceTwd: 320, ...(categoryId === undefined ? {} : { categoryId }) });

describe("商品所屬分類", () => {
  beforeEach(resetDb);

  it("新商品沒有分類；管理員設定後，商品與商品清單都帶出分類", async () => {
    const jwt = await mintAccessJwt();
    const id = await createMug(jwt);
    expect(await app.getProductForAdmin(jwt, { id })).toMatchObject({ ok: true, data: { category: null } });

    const categoryId = await createCategory(jwt, "dining", "餐廳");
    expect(await app.updateProduct(jwt, mugInput(id, categoryId))).toEqual({ ok: true, data: { id } });

    const expected = { id: categoryId, slug: "dining", name: "餐廳" };
    expect(await app.getProductForAdmin(jwt, { id })).toMatchObject({ ok: true, data: { category: expected } });
    expect(await app.listProductsForAdmin(jwt)).toMatchObject({ ok: true, data: [{ id, category: expected }] });
  });

  it("指定不存在的分類回 category_not_found，商品不變", async () => {
    const jwt = await mintAccessJwt();
    const id = await createMug(jwt);
    expect(await app.updateProduct(jwt, { ...mugInput(id, 9999), name: "改名" })).toEqual({ ok: false, reason: "category_not_found" });
    expect(await app.getProductForAdmin(jwt, { id })).toMatchObject({ ok: true, data: { name: "馬克杯", category: null } });
  });

  it("不帶分類欄位的修改保留原分類；帶 null 才清空", async () => {
    const jwt = await mintAccessJwt();
    const id = await createMug(jwt);
    const categoryId = await createCategory(jwt);
    await assignCategory(jwt, id, categoryId);

    await app.updateProduct(jwt, { ...mugInput(id), name: "大馬克杯" });
    expect(await app.getProductForAdmin(jwt, { id })).toMatchObject({ ok: true, data: { name: "大馬克杯", category: { id: categoryId } } });

    expect(await app.updateProduct(jwt, mugInput(id, null))).toEqual({ ok: true, data: { id } });
    expect(await app.getProductForAdmin(jwt, { id })).toMatchObject({ ok: true, data: { category: null } });
  });

  it.each([0, -1, 1.5, "1", Number.NaN])("分類編號 %j 不合法，帶 invalid_input", async (categoryId) => {
    const jwt = await mintAccessJwt();
    const id = await createMug(jwt);
    expect(await app.updateProduct(jwt, { ...mugInput(id), categoryId })).toMatchObject({ ok: false, reason: "invalid_input", fields: { categoryId: [expect.any(String)] } });
  });

  it("沒有 Access JWT 的設定分類被拒絕，商品不變", async () => {
    const jwt = await mintAccessJwt();
    const id = await createMug(jwt);
    const categoryId = await createCategory(jwt);
    expect(await app.updateProduct("", mugInput(id, categoryId))).toEqual({ ok: false, reason: "unauthorized" });
    expect(await app.getProductForAdmin(jwt, { id })).toMatchObject({ ok: true, data: { category: null } });
  });
});

describe("上架必須有分類", () => {
  beforeEach(resetDb);

  it("有圖片但沒有分類不能上架，回 no_category；設定分類後可以", async () => {
    const jwt = await mintAccessJwt();
    const id = await createMug(jwt);
    await addImage(jwt, id);
    expect(await app.relistProduct(jwt, { id })).toEqual({ ok: false, reason: "no_category" });
    expect(await app.listProducts()).toEqual({ ok: true, data: { items: [], total: 0, hasMore: false } });
    expect(await app.getProductForAdmin(jwt, { id })).toMatchObject({ ok: true, data: { listed: false } });

    await assignCategory(jwt, id, await createCategory(jwt));
    expect(await app.relistProduct(jwt, { id })).toEqual({ ok: true, data: { id } });
  });

  it("圖片與分類都缺時，先回 no_images（沿用既有的圖片檢查，分類檢查排在後面）", async () => {
    const jwt = await mintAccessJwt();
    const id = await createMug(jwt);
    expect(await app.relistProduct(jwt, { id })).toEqual({ ok: false, reason: "no_images" });
  });

  it("下架後清掉分類，重新上架同樣回 no_category", async () => {
    const jwt = await mintAccessJwt();
    const id = await createMug(jwt);
    await assignCategory(jwt, id, await createCategory(jwt));
    await addImage(jwt, id);
    await app.relistProduct(jwt, { id });
    await app.unlistProduct(jwt, { id });
    expect(await app.updateProduct(jwt, mugInput(id, null))).toEqual({ ok: true, data: { id } });
    expect(await app.relistProduct(jwt, { id })).toEqual({ ok: false, reason: "no_category" });
  });

  it("上架中的商品不能把分類清成空，回 no_category 且商品完全不變；可以改成另一個分類", async () => {
    const jwt = await mintAccessJwt();
    const id = await createMug(jwt);
    const living = await createCategory(jwt, "living", "客廳");
    const dining = await createCategory(jwt, "dining", "餐廳");
    await assignCategory(jwt, id, living);
    await uploadAndList(jwt, id);

    expect(await app.updateProduct(jwt, { ...mugInput(id, null), name: "改名" })).toEqual({ ok: false, reason: "no_category" });
    expect(await app.getProductForAdmin(jwt, { id })).toMatchObject({ ok: true, data: { name: "馬克杯", listed: true, category: { id: living } } });

    expect(await app.updateProduct(jwt, mugInput(id, dining))).toEqual({ ok: true, data: { id } });
    expect(await app.getProductForAdmin(jwt, { id })).toMatchObject({ ok: true, data: { listed: true, category: { id: dining } } });
  });

  it("沒有 Access JWT 的上架被拒絕，商品維持下架", async () => {
    const jwt = await mintAccessJwt();
    const id = await createMug(jwt);
    await assignCategory(jwt, id, await createCategory(jwt));
    await addImage(jwt, id);
    expect(await app.relistProduct("", { id })).toEqual({ ok: false, reason: "unauthorized" });
    expect(await app.getProductForAdmin(jwt, { id })).toMatchObject({ ok: true, data: { listed: false } });
  });
});

describe("上架時間", () => {
  beforeEach(resetDb);

  // Access JWT 在簽發後一小時內有效，所以各時間點只差幾分鐘，並先設好時間再簽發
  const T0 = Date.UTC(2030, 0, 1, 8);
  const [T1, T2, T3, T4] = [1, 2, 3, 4].map((minutes) => T0 + minutes * 60_000) as [number, number, number, number];

  async function twoListedProducts(jwt: string) {
    const categoryId = await createCategory(jwt);
    const first = await createMug(jwt, "先上架");
    const second = await createMug(jwt, "後上架");
    for (const id of [first, second]) { await assignCategory(jwt, id, categoryId); await addImage(jwt, id); }
    setNow(T1);
    await app.relistProduct(jwt, { id: first });
    setNow(T2);
    await app.relistProduct(jwt, { id: second });
    return { first, second };
  }

  const orderOf = async () => {
    const result = await app.listProducts({ category: "living" });
    if (!result.ok) throw new Error(`取得商品列表失敗：${result.reason}`);
    return result.data.items.map((product) => product.name);
  };

  it("分類頁的商品依上架時間由新到舊，不是依新增順序", async () => {
    setNow(T0);
    const jwt = await mintAccessJwt();
    await twoListedProducts(jwt);
    expect(await orderOf()).toEqual(["後上架", "先上架"]);
  });

  it("下架後重新上架會重設上架時間，變成最新的一件", async () => {
    setNow(T0);
    const jwt = await mintAccessJwt();
    const { first } = await twoListedProducts(jwt);
    setNow(T3);
    await app.unlistProduct(jwt, { id: first });
    setNow(T4);
    await app.relistProduct(jwt, { id: first });
    expect(await orderOf()).toEqual(["先上架", "後上架"]);
  });

  it("已上架的商品重複上架是冪等的，不會重設上架時間", async () => {
    setNow(T0);
    const jwt = await mintAccessJwt();
    const { first } = await twoListedProducts(jwt);
    setNow(T4);
    expect(await app.relistProduct(jwt, { id: first })).toEqual({ ok: true, data: { id: first } });
    expect(await orderOf()).toEqual(["後上架", "先上架"]);
  });
});
