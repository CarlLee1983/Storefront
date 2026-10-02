import { exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { mintAccessJwt } from "./access";
import { setNow } from "./clock";
import { resetDb } from "./db";
import { uploadAndList } from "./images";

const app = exports.default;

/** 在指定時間新增並上架一件商品（上架時間 = 該時間），回傳商品 id。 */
async function listedProduct(jwt: string, name: string, at: number): Promise<number> {
  setNow(at);
  const created = await app.createProduct(jwt, { name, description: `${name}的說明`, priceTwd: 500 });
  if (!created.ok) throw new Error("新增商品失敗");
  await uploadAndList(jwt, created.data.id);
  return created.data.id;
}

async function feature(jwt: string, id: number, at: number, featured = true) {
  setNow(at);
  const result = await app.setProductFeatured(jwt, { id, featured });
  if (!result.ok) throw new Error(`設定精選失敗：${result.reason}`);
}

async function featuredNames(): Promise<string[]> {
  const result = await app.getFeaturedProducts();
  if (!result.ok) throw new Error("getFeaturedProducts 失敗");
  return result.data.map((item) => item.name);
}

describe("管理員切換精選", () => {
  beforeEach(resetDb);

  it("標為精選後，商品與商品清單都帶出精選狀態；取消後清除", async () => {
    const jwt = await mintAccessJwt();
    const id = await listedProduct(jwt, "沙發", 1000);
    expect(await app.getProductForAdmin(jwt, { id })).toMatchObject({ ok: true, data: { featured: false } });

    expect(await app.setProductFeatured(jwt, { id, featured: true })).toEqual({ ok: true, data: { id } });
    expect(await app.getProductForAdmin(jwt, { id })).toMatchObject({ ok: true, data: { featured: true } });
    expect(await app.listProductsForAdmin(jwt)).toMatchObject({ ok: true, data: [{ id, featured: true }] });

    expect(await app.setProductFeatured(jwt, { id, featured: false })).toEqual({ ok: true, data: { id } });
    expect(await app.getProductForAdmin(jwt, { id })).toMatchObject({ ok: true, data: { featured: false } });
  });

  it("已是精選再標一次不更新精選時間（冪等）", async () => {
    const jwt = await mintAccessJwt();
    const first = await listedProduct(jwt, "先標", 1000);
    const second = await listedProduct(jwt, "後標", 1000);
    await feature(jwt, first, 2000);
    await feature(jwt, second, 3000);
    await feature(jwt, first, 4000);
    expect((await featuredNames()).slice(0, 2)).toEqual(["後標", "先標"]);
  });

  it("取消後再標為精選，精選時間重新計算", async () => {
    const jwt = await mintAccessJwt();
    const first = await listedProduct(jwt, "甲", 1000);
    const second = await listedProduct(jwt, "乙", 1000);
    await feature(jwt, first, 2000);
    await feature(jwt, second, 3000);
    await feature(jwt, first, 4000, false);
    await feature(jwt, first, 5000);
    expect((await featuredNames()).slice(0, 2)).toEqual(["甲", "乙"]);
  });

  it("商品不存在回 product_not_found", async () => {
    const jwt = await mintAccessJwt();
    expect(await app.setProductFeatured(jwt, { id: 9999, featured: true })).toEqual({ ok: false, reason: "product_not_found" });
  });

  it.each([{ id: 0, featured: true }, { id: 1, featured: "yes" }, { id: 1 }, {}])("輸入 %j 不合法，帶 invalid_input", async (input) => {
    const jwt = await mintAccessJwt();
    expect(await app.setProductFeatured(jwt, input)).toMatchObject({ ok: false, reason: "invalid_input" });
  });

  it("沒有 Access JWT 被拒絕，精選狀態不變", async () => {
    const jwt = await mintAccessJwt();
    const id = await listedProduct(jwt, "沙發", 1000);
    expect(await app.setProductFeatured("", { id, featured: true })).toEqual({ ok: false, reason: "unauthorized" });
    expect(await app.getProductForAdmin(jwt, { id })).toMatchObject({ ok: true, data: { featured: false } });
  });
});

describe("首頁精選商品", () => {
  beforeEach(resetDb);

  it("沒有任何上架商品時為空陣列", async () => {
    expect(await app.getFeaturedProducts()).toEqual({ ok: true, data: [] });
  });

  it("項目形狀與前台商品項目相同", async () => {
    const jwt = await mintAccessJwt();
    const id = await listedProduct(jwt, "沙發", 1000);
    await feature(jwt, id, 2000);
    expect(await app.getFeaturedProducts()).toEqual({
      ok: true,
      data: [{ id, name: "沙發", description: "沙發的說明", defaultVariantId: expect.any(Number), priceTwd: 500, compareAtPriceTwd: null, purchasable: false, cover: expect.objectContaining({ id: expect.any(String) }) }],
    });
  });

  it("特價商品帶出原價，精選與補位都一樣", async () => {
    const jwt = await mintAccessJwt();
    const featured = await listedProduct(jwt, "精選特價", 1000);
    const filler = await listedProduct(jwt, "補位特價", 2000);
    for (const id of [featured, filler]) {
      const updated = await app.updateProduct(jwt, { id, name: id === featured ? "精選特價" : "補位特價", description: "說明", priceTwd: 500, compareAtPriceTwd: 800 });
      if (!updated.ok) throw new Error(`設定原價失敗：${updated.reason}`);
    }
    await feature(jwt, featured, 3000);
    const result = await app.getFeaturedProducts();
    expect(result).toMatchObject({ ok: true, data: [{ name: "精選特價", compareAtPriceTwd: 800 }, { name: "補位特價", compareAtPriceTwd: 800 }] });
  });

  it("依精選時間由新到舊，最多 4 件", async () => {
    const jwt = await mintAccessJwt();
    const ids: number[] = [];
    for (const [index, name] of ["一", "二", "三", "四", "五"].entries()) ids.push(await listedProduct(jwt, name, 1000 + index));
    // 精選順序與上架順序刻意不同
    for (const [index, position] of [2, 0, 4, 1, 3].entries()) await feature(jwt, ids[position]!, 2000 + index);
    expect(await featuredNames()).toEqual(["四", "二", "五", "一"]);
  });

  it("精選不足 4 件時，以上架時間最新且未入選的商品補滿，不重複", async () => {
    const jwt = await mintAccessJwt();
    const old = await listedProduct(jwt, "舊精選", 1000);
    await listedProduct(jwt, "最舊", 1001);
    await listedProduct(jwt, "較新", 3000);
    await listedProduct(jwt, "次新", 4000);
    await listedProduct(jwt, "最新", 5000);
    await feature(jwt, old, 6000);
    expect(await featuredNames()).toEqual(["舊精選", "最新", "次新", "較新"]);
  });

  it("沒有精選時全由最新上架補位", async () => {
    const jwt = await mintAccessJwt();
    for (const [index, name] of ["一", "二", "三", "四", "五"].entries()) await listedProduct(jwt, name, 1000 + index);
    expect(await featuredNames()).toEqual(["五", "四", "三", "二"]);
  });

  it("上架商品不足 4 件時全部列出且不重複", async () => {
    const jwt = await mintAccessJwt();
    const featured = await listedProduct(jwt, "精選", 1000);
    await listedProduct(jwt, "另一件", 2000);
    await feature(jwt, featured, 3000);
    expect(await featuredNames()).toEqual(["精選", "另一件"]);
  });

  it("下架的精選商品不出現也不佔名額；補位只取上架商品；重新上架後回到精選區", async () => {
    const jwt = await mintAccessJwt();
    const hiddenFeatured = await listedProduct(jwt, "下架精選", 1000);
    await listedProduct(jwt, "上架中", 2000);
    const hiddenPlain = await listedProduct(jwt, "下架普通", 3000);
    await feature(jwt, hiddenFeatured, 4000);
    await app.unlistProduct(jwt, { id: hiddenFeatured });
    await app.unlistProduct(jwt, { id: hiddenPlain });
    expect(await featuredNames()).toEqual(["上架中"]);

    // 下架時保有精選標記
    expect(await app.getProductForAdmin(jwt, { id: hiddenFeatured })).toMatchObject({ ok: true, data: { featured: true } });
    await app.relistProduct(jwt, { id: hiddenFeatured });
    expect(await featuredNames()).toEqual(["下架精選", "上架中"]);
  });

  it("所有商品都下架時為空陣列", async () => {
    const jwt = await mintAccessJwt();
    const id = await listedProduct(jwt, "沙發", 1000);
    await feature(jwt, id, 2000);
    await app.unlistProduct(jwt, { id });
    expect(await app.getFeaturedProducts()).toEqual({ ok: true, data: [] });
  });
});
