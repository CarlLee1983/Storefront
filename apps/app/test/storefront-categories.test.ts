import { exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { mintAccessJwt } from "./access";
import { assignCategory, createCategory } from "./categories";
import { resetDb } from "./db";
import { uploadAndList } from "./images";

const app = exports.default;

/** 新增商品、歸類並上架，回傳商品 id。 */
async function listedProduct(jwt: string, categoryId: number, name: string) {
  const created = await app.createProduct(jwt, { name, description: `${name}的說明`, priceTwd: 500 });
  if (!created.ok) throw new Error("新增商品失敗");
  await assignCategory(jwt, created.data.id, categoryId);
  await uploadAndList(jwt, created.data.id);
  return created.data.id;
}

describe("前台分類清單", () => {
  beforeEach(resetDb);

  it("只回傳至少有一件上架商品的分類，依建立順序", async () => {
    const jwt = await mintAccessJwt();
    const living = await createCategory(jwt, "living", "客廳", "沙發與燈");
    await createCategory(jwt, "empty", "空分類", "沒有商品");
    const unlistedOnly = await createCategory(jwt, "unlisted", "只有下架", "只有下架的商品");
    const dining = await createCategory(jwt, "dining", "餐廳", "餐桌與餐具");
    const hidden = await listedProduct(jwt, unlistedOnly, "下架商品");
    await app.unlistProduct(jwt, { id: hidden });
    // 先上架餐廳的商品，確認順序跟上架先後無關，只看分類的建立順序
    await listedProduct(jwt, dining, "餐盤");
    await listedProduct(jwt, living, "沙發");

    expect(await app.listCategories()).toEqual({
      ok: true,
      data: [
        { id: living, slug: "living", name: "客廳", description: "沙發與燈" },
        { id: dining, slug: "dining", name: "餐廳", description: "餐桌與餐具" },
      ],
    });
  });

  it("最後一件上架商品下架後，分類從前台消失", async () => {
    const jwt = await mintAccessJwt();
    const living = await createCategory(jwt);
    const id = await listedProduct(jwt, living, "沙發");
    expect(await app.listCategories()).toMatchObject({ ok: true, data: [{ slug: "living" }] });
    await app.unlistProduct(jwt, { id });
    expect(await app.listCategories()).toEqual({ ok: true, data: [] });
  });
});

describe("依代稱取得前台分類", () => {
  beforeEach(resetDb);

  it("只回傳分類本身；其上架商品由 listProducts 依分類取得，不含其他分類與下架的商品", async () => {
    const jwt = await mintAccessJwt();
    const living = await createCategory(jwt, "living", "客廳", "沙發與燈");
    const dining = await createCategory(jwt, "dining", "餐廳", "餐桌與餐具");
    const sofa = await listedProduct(jwt, living, "沙發");
    const gone = await listedProduct(jwt, living, "下架的椅子");
    await listedProduct(jwt, dining, "餐盤");
    await app.unlistProduct(jwt, { id: gone });

    const category = await app.getCategory({ slug: "living" });
    expect(category).toEqual({
      ok: true,
      data: {
        id: living,
        slug: "living",
        name: "客廳",
        description: "沙發與燈",
        listedProductCount: 1,
      },
    });
    expect(await app.listProducts({ category: "living" })).toEqual({
      ok: true,
      data: {
        items: [{ id: sofa, name: "沙發", description: "沙發的說明", priceTwd: 500, purchasable: false, cover: expect.objectContaining({ id: expect.any(String) }) }],
        total: 1,
        hasMore: false,
      },
    });
  });

  it("listedProductCount 是分類內的上架商品數：不含下架商品，也不受 listProducts 的篩選影響", async () => {
    const jwt = await mintAccessJwt();
    const living = await createCategory(jwt, "living", "客廳", "沙發與燈");
    await listedProduct(jwt, living, "沙發");
    await listedProduct(jwt, living, "茶几");
    await app.unlistProduct(jwt, { id: await listedProduct(jwt, living, "下架的椅子") });
    expect(await app.getCategory({ slug: "living" })).toMatchObject({ ok: true, data: { listedProductCount: 2 } });
    // 兩件都沒有庫存：只看有貨的列表是空的，分類的件數不變
    expect(await app.listProducts({ category: "living", inStock: true })).toMatchObject({ ok: true, data: { total: 0 } });
    expect(await app.getCategory({ slug: "living" })).toMatchObject({ ok: true, data: { listedProductCount: 2 } });
  });

  it("代稱不存在、分類沒有商品、只有下架商品，都回 not_found", async () => {
    const jwt = await mintAccessJwt();
    await createCategory(jwt, "empty", "空分類");
    const unlistedOnly = await createCategory(jwt, "unlisted", "只有下架");
    await app.unlistProduct(jwt, { id: await listedProduct(jwt, unlistedOnly, "下架商品") });

    const notFound = { ok: false, reason: "not_found" };
    expect(await app.getCategory({ slug: "nope" })).toEqual(notFound);
    expect(await app.getCategory({ slug: "empty" })).toEqual(notFound);
    expect(await app.getCategory({ slug: "unlisted" })).toEqual(notFound);
  });

  it.each([null, undefined, {}, "living", { slug: 1 }, { slug: "" }, { slug: "Living" }, { slug: "../x" }])("不合法的輸入 %j 回 not_found", async (input) => {
    const jwt = await mintAccessJwt();
    await listedProduct(jwt, await createCategory(jwt), "沙發");
    expect(await app.getCategory(input)).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("商品詳情帶出分類", () => {
  beforeEach(resetDb);

  it("前台取得商品時帶出所屬分類的代稱與名稱，不含說明與編號", async () => {
    const jwt = await mintAccessJwt();
    const living = await createCategory(jwt, "living", "客廳", "沙發與燈");
    const id = await listedProduct(jwt, living, "沙發");
    const result = await app.getProduct({ id });
    if (!result.ok) throw new Error("getProduct");
    expect(result.data.category).toEqual({ slug: "living", name: "客廳" });
  });
});
