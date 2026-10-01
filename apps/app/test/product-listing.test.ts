import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { mintAccessJwt } from "./access";
import { createCategory } from "./categories";
import { resetDb } from "./db";
import { seedImageAndList } from "./images";

const app = exports.default;

interface Seed {
  name: string;
  priceTwd?: number;
  /** 在庫數；預設 0（已售完）。 */
  stock?: number;
  /** 上架時間（epoch 毫秒）；預設 0。 */
  listedAt?: number;
}

/** 新增商品並直接安排成上架、指定分類與上架時間（只做前置條件；斷言一律走 RPC）。 */
async function seedProduct(jwt: string, categoryId: number, { name, priceTwd = 500, stock = 0, listedAt = 0 }: Seed): Promise<number> {
  const created = await app.createProduct(jwt, { name, description: `${name}的說明`, priceTwd });
  if (!created.ok) throw new Error("新增商品失敗");
  const { id } = created.data;
  await seedImageAndList(id);
  await env.DB.prepare("UPDATE products SET category_id = ?, listed_at = ?, on_hand = ? WHERE id = ?").bind(categoryId, listedAt, stock, id).run();
  return id;
}

/** 一次寫入大量上架商品（沒有封面；只用來測分頁），編號與上架時間都隨序號遞增。 */
async function seedBulk(categoryId: number, count: number): Promise<void> {
  const insert = env.DB.prepare("INSERT INTO products (name, description, price_twd, listed, on_hand, category_id, listed_at) VALUES (?, '', 500, 1, 0, ?, ?)");
  await env.DB.batch(Array.from({ length: count }, (_, index) => insert.bind(`商品${String(index + 1).padStart(2, "0")}`, categoryId, index + 1)));
}

async function names(input?: unknown): Promise<string[]> {
  const result = await app.listProducts(input);
  if (!result.ok) throw new Error(`listProducts 失敗：${result.reason}`);
  return result.data.items.map((item) => item.name);
}

describe("前台商品列表查詢", () => {
  beforeEach(resetDb);

  it("沒有輸入時列出所有上架商品，回傳商品項目（含封面）、總件數與是否還有更多", async () => {
    const jwt = await mintAccessJwt();
    const living = await createCategory(jwt);
    const id = await seedProduct(jwt, living, { name: "沙發", stock: 2 });
    const hidden = await seedProduct(jwt, living, { name: "下架的椅子" });
    await app.unlistProduct(jwt, { id: hidden });

    expect(await app.listProducts()).toEqual({
      ok: true,
      data: {
        items: [{ id, name: "沙發", description: "沙發的說明", priceTwd: 500, compareAtPriceTwd: null, purchasable: true, cover: expect.objectContaining({ id: expect.any(String) }) }],
        total: 1,
        hasMore: false,
      },
    });
  });

  it("沒有任何上架商品時回空結果", async () => {
    expect(await app.listProducts()).toEqual({ ok: true, data: { items: [], total: 0, hasMore: false } });
  });

  it("依分類代稱只列該分類的上架商品；分類不存在回空結果而不是錯誤", async () => {
    const jwt = await mintAccessJwt();
    const living = await createCategory(jwt, "living", "客廳");
    const dining = await createCategory(jwt, "dining", "餐廳");
    await seedProduct(jwt, living, { name: "沙發" });
    await seedProduct(jwt, dining, { name: "餐盤" });

    expect(await names({ category: "living" })).toEqual(["沙發"]);
    expect(await names({ category: "dining" })).toEqual(["餐盤"]);
    expect(await app.listProducts({ category: "nope" })).toEqual({ ok: true, data: { items: [], total: 0, hasMore: false } });
  });

  it("只看有貨只留下可售數量大於 0 的商品，total 也只算這些", async () => {
    const jwt = await mintAccessJwt();
    const living = await createCategory(jwt);
    await seedProduct(jwt, living, { name: "有貨", stock: 3 });
    await seedProduct(jwt, living, { name: "售完", stock: 0 });

    expect(await names({ inStock: true })).toEqual(["有貨"]);
    expect(await app.listProducts({ inStock: true })).toMatchObject({ ok: true, data: { total: 1 } });
    expect((await names({ inStock: false })).sort()).toEqual(["售完", "有貨"].sort());
    expect(await app.listProducts()).toMatchObject({ ok: true, data: { total: 2 } });
  });

  it("三種排序：預設與 new 依上架時間新到舊，price-asc／price-desc 依售價", async () => {
    const jwt = await mintAccessJwt();
    const living = await createCategory(jwt);
    await seedProduct(jwt, living, { name: "中價舊品", priceTwd: 500, listedAt: 1000 });
    await seedProduct(jwt, living, { name: "高價新品", priceTwd: 900, listedAt: 3000 });
    await seedProduct(jwt, living, { name: "低價中品", priceTwd: 100, listedAt: 2000 });

    expect(await names()).toEqual(["高價新品", "低價中品", "中價舊品"]);
    expect(await names({ sort: "new" })).toEqual(["高價新品", "低價中品", "中價舊品"]);
    expect(await names({ sort: "price-asc" })).toEqual(["低價中品", "中價舊品", "高價新品"]);
    expect(await names({ sort: "price-desc" })).toEqual(["高價新品", "中價舊品", "低價中品"]);
  });

  it("排序值相同時一律以 id 遞減，順序穩定", async () => {
    const jwt = await mintAccessJwt();
    const living = await createCategory(jwt);
    await seedProduct(jwt, living, { name: "甲", priceTwd: 500, listedAt: 1000 });
    await seedProduct(jwt, living, { name: "乙", priceTwd: 500, listedAt: 1000 });
    await seedProduct(jwt, living, { name: "丙", priceTwd: 500, listedAt: 1000 });

    for (const sort of ["new", "price-asc", "price-desc"]) expect(await names({ sort }), sort).toEqual(["丙", "乙", "甲"]);
  });

  it("每頁 24 件，第 N 頁回傳第 1 到第 N 頁的累計結果，並算出 total 與 hasMore", async () => {
    const jwt = await mintAccessJwt();
    const living = await createCategory(jwt);
    await seedBulk(living, 50);

    const first = await app.listProducts({ sort: "new" });
    const second = await app.listProducts({ sort: "new", page: 2 });
    const third = await app.listProducts({ sort: "new", page: 3 });
    if (!first.ok || !second.ok || !third.ok) throw new Error("listProducts 失敗");
    expect([first.data.items.length, first.data.total, first.data.hasMore]).toEqual([24, 50, true]);
    expect([second.data.items.length, second.data.total, second.data.hasMore]).toEqual([48, 50, true]);
    expect([third.data.items.length, third.data.total, third.data.hasMore]).toEqual([50, 50, false]);
    // 累計結果以前一頁為前綴
    expect(second.data.items.slice(0, 24)).toEqual(first.data.items);
    expect(third.data.items.slice(0, 48)).toEqual(second.data.items);
    expect(third.data.items[0]).toMatchObject({ name: "商品50" });
  });

  it("剛好滿一頁時 hasMore 為 false", async () => {
    const jwt = await mintAccessJwt();
    const living = await createCategory(jwt);
    await seedBulk(living, 24);
    expect(await app.listProducts()).toMatchObject({ ok: true, data: { total: 24, hasMore: false } });
  });

  it("頁數上限 20：第 20 頁可用，超過或不合法的輸入回 invalid_input", async () => {
    expect(await app.listProducts({ page: 20 })).toMatchObject({ ok: true });
    for (const input of [{ page: 21 }, { page: 0 }, { page: -1 }, { page: 1.5 }, { page: "2" }, { sort: "random" }, { inStock: "yes" }, { category: 1 }, { category: "Bad Slug" }, "living", null]) {
      expect(await app.listProducts(input), JSON.stringify(input)).toMatchObject({ ok: false, reason: "invalid_input" });
    }
  });

  describe("關鍵字搜尋 q", () => {
    /** 以名稱與說明各自可識別的商品安排搜尋情境；說明預設是「{名稱}的說明」。 */
    async function seedNamed(jwt: string, categoryId: number, name: string, description?: string, seed: Omit<Seed, "name"> = {}): Promise<number> {
      const id = await seedProduct(jwt, categoryId, { name, ...seed });
      if (description !== undefined) await env.DB.prepare("UPDATE products SET description = ? WHERE id = ?").bind(description, id).run();
      return id;
    }

    it("名稱與說明都能命中，且只列上架商品", async () => {
      const jwt = await mintAccessJwt();
      const living = await createCategory(jwt);
      await seedNamed(jwt, living, "弧形單椅", "柔和的曲線");
      await seedNamed(jwt, living, "邊桌", "搭配弧形單椅使用");
      await seedNamed(jwt, living, "檯燈", "暖色光源");
      const hidden = await seedNamed(jwt, living, "弧形下架品", "弧形");
      await app.unlistProduct(jwt, { id: hidden });

      expect((await names({ q: "弧形" })).sort()).toEqual(["弧形單椅", "邊桌"].sort());
      expect(await names({ q: "光源" })).toEqual(["檯燈"]);
      expect(await app.listProducts({ q: "弧形" })).toMatchObject({ ok: true, data: { total: 2, hasMore: false } });
      expect(await app.listProducts({ q: "找不到的字" })).toEqual({ ok: true, data: { items: [], total: 0, hasMore: false } });
    });

    it("英文不分大小寫", async () => {
      const jwt = await mintAccessJwt();
      const living = await createCategory(jwt);
      await seedNamed(jwt, living, "Luma 弧形單椅", "");
      await seedNamed(jwt, living, "檯燈", "Warm LIGHT");

      expect(await names({ q: "luma" })).toEqual(["Luma 弧形單椅"]);
      expect(await names({ q: "LUMA" })).toEqual(["Luma 弧形單椅"]);
      expect(await names({ q: "light" })).toEqual(["檯燈"]);
    });

    it("% 與 _ 與反斜線都視為一般字元，不是萬用字元", async () => {
      const jwt = await mintAccessJwt();
      const living = await createCategory(jwt);
      await seedNamed(jwt, living, "100% 純棉", "");
      await seedNamed(jwt, living, "a_b 杯", "");
      await seedNamed(jwt, living, "axb 杯", "");
      await seedNamed(jwt, living, "路徑 a\\b", "");
      await seedNamed(jwt, living, "普通商品", "");

      expect(await names({ q: "%" })).toEqual(["100% 純棉"]);
      expect(await names({ q: "_" })).toEqual(["a_b 杯"]);
      expect(await names({ q: "a_b" })).toEqual(["a_b 杯"]);
      expect(await names({ q: "\\" })).toEqual(["路徑 a\\b"]);
      expect(await names({ q: "100%" })).toEqual(["100% 純棉"]);
    });

    it("單引號等字元當成資料，不會改變查詢", async () => {
      const jwt = await mintAccessJwt();
      const living = await createCategory(jwt);
      await seedNamed(jwt, living, "普通商品", "");
      expect(await names({ q: "' OR 1=1 --" })).toEqual([]);
    });

    it("前後空白會先去掉；空字串與只有空白視同沒有帶", async () => {
      const jwt = await mintAccessJwt();
      const living = await createCategory(jwt);
      await seedNamed(jwt, living, "沙發", "");
      await seedNamed(jwt, living, "餐盤", "");

      expect(await names({ q: "  沙發  " })).toEqual(["沙發"]);
      expect((await names({ q: "" })).sort()).toEqual(["沙發", "餐盤"].sort());
      expect((await names({ q: "   " })).sort()).toEqual(["沙發", "餐盤"].sort());
    });

    it("長度上限 50 字（去掉空白後計算）：剛好 50 可用，51 回 invalid_input", async () => {
      expect(await app.listProducts({ q: "a".repeat(50) })).toMatchObject({ ok: true });
      expect(await app.listProducts({ q: ` ${"a".repeat(50)} ` })).toMatchObject({ ok: true });
      expect(await app.listProducts({ q: "a".repeat(51) })).toMatchObject({ ok: false, reason: "invalid_input", fields: { q: [expect.any(String)] } });
      expect(await app.listProducts({ q: 5 })).toMatchObject({ ok: false, reason: "invalid_input" });
    });

    it("可與分類、只看有貨、排序組合，total 依篩選後計算", async () => {
      const jwt = await mintAccessJwt();
      const living = await createCategory(jwt, "living", "客廳");
      const dining = await createCategory(jwt, "dining", "餐廳");
      await seedNamed(jwt, living, "木質椅甲", "", { priceTwd: 300, stock: 1, listedAt: 1 });
      await seedNamed(jwt, living, "木質椅乙", "", { priceTwd: 900, stock: 1, listedAt: 2 });
      await seedNamed(jwt, living, "木質椅丙", "", { priceTwd: 600, stock: 0, listedAt: 3 });
      await seedNamed(jwt, dining, "木質餐盤", "", { priceTwd: 100, stock: 1, listedAt: 4 });
      await seedNamed(jwt, living, "鐵製椅", "", { priceTwd: 100, stock: 1, listedAt: 5 });

      expect(await names({ q: "木質", category: "living", sort: "price-asc" })).toEqual(["木質椅甲", "木質椅丙", "木質椅乙"]);
      expect(await names({ q: "木質", category: "living", inStock: true, sort: "price-desc" })).toEqual(["木質椅乙", "木質椅甲"]);
      expect(await app.listProducts({ q: "木質", inStock: true })).toMatchObject({ ok: true, data: { total: 3 } });
    });

    it("分頁：total 與 hasMore 依搜尋後的結果計算", async () => {
      const jwt = await mintAccessJwt();
      const living = await createCategory(jwt);
      await seedBulk(living, 30);
      await seedNamed(jwt, living, "特別的椅子", "");

      expect(await app.listProducts({ q: "商品" })).toMatchObject({ ok: true, data: { total: 30, hasMore: true } });
      const second = await app.listProducts({ q: "商品", page: 2 });
      if (!second.ok) throw new Error("listProducts 失敗");
      expect([second.data.items.length, second.data.total, second.data.hasMore]).toEqual([30, 30, false]);
      expect(await app.listProducts({ q: "特別" })).toMatchObject({ ok: true, data: { total: 1, hasMore: false } });
    });
  });
});
