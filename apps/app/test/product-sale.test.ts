import { exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { mintAccessJwt } from "./access";
import { checkoutInput, createStockedListing } from "./checkout-helpers";
import { signInCustomer } from "./customers";
import { resetDb } from "./db";

const app = exports.default;

/** 以必填欄位組出修改輸入；原價與其他選填欄位由各測試追加。 */
function edit(id: number, priceTwd: number, rest: Record<string, unknown> = {}) {
  return { id, name: "馬克杯", description: "說明", priceTwd, ...rest };
}

async function compareAtOf(jwt: string, id: number): Promise<number | null> {
  const found = await app.getProductForAdmin(jwt, { id });
  if (!found.ok) throw new Error(`讀取商品失敗：${found.reason}`);
  return found.data.compareAtPriceTwd;
}

async function hasSale(): Promise<{ ok: true; data: boolean }> {
  const nav = await app.getStorefrontNav();
  return { ok: true, data: nav.data.hasSale };
}

async function listedNames(input?: unknown): Promise<string[]> {
  const result = await app.listProducts(input);
  if (!result.ok) throw new Error(`listProducts 失敗：${result.reason}`);
  return result.data.items.map((item) => item.name);
}

describe("原價", () => {
  beforeEach(resetDb);

  it("新商品沒有原價", async () => {
    const jwt = await mintAccessJwt();
    const id = (await createStockedListing("馬克杯", 320, 5)).productId;
    expect(await compareAtOf(jwt, id)).toBeNull();
  });

  it("設定原價後，前台列表、詳情與後台清單都帶出原價", async () => {
    const jwt = await mintAccessJwt();
    const id = (await createStockedListing("馬克杯", 320, 5)).productId;

    expect(await app.updateProduct(jwt, edit(id, 320, { compareAtPriceTwd: 450 }))).toEqual({ ok: true, data: { id } });

    expect(await app.listProducts()).toMatchObject({ ok: true, data: { items: [{ id, priceTwd: 320, compareAtPriceTwd: 450 }] } });
    expect(await app.getProduct({ id })).toMatchObject({ ok: true, data: { priceTwd: 320, compareAtPriceTwd: 450 } });
    expect(await app.listProductsForAdmin(jwt)).toMatchObject({ ok: true, data: [{ id, compareAtPriceTwd: 450 }] });
    expect(await compareAtOf(jwt, id)).toBe(450);
  });

  it("沒有原價的商品，前台項目的原價是 null", async () => {
    const id = (await createStockedListing("馬克杯", 320, 5)).productId;
    expect(await app.listProducts()).toMatchObject({ ok: true, data: { items: [{ id, compareAtPriceTwd: null }] } });
    expect(await app.getProduct({ id })).toMatchObject({ ok: true, data: { compareAtPriceTwd: null } });
  });

  it.each([[320], [300]])("原價 %i 不高於售價 320：回 invalid_compare_at_price，原價不變", async (compareAt) => {
    const jwt = await mintAccessJwt();
    const id = (await createStockedListing("馬克杯", 320, 5)).productId;

    expect(await app.updateProduct(jwt, edit(id, 320, { compareAtPriceTwd: compareAt }))).toEqual({ ok: false, reason: "invalid_compare_at_price" });
    expect(await compareAtOf(jwt, id)).toBeNull();
  });

  it("被拒絕的儲存不會改到其他欄位", async () => {
    const jwt = await mintAccessJwt();
    const id = (await createStockedListing("馬克杯", 320, 5)).productId;

    await app.updateProduct(jwt, edit(id, 100, { name: "新名字", compareAtPriceTwd: 100 }));

    expect(await app.getProductForAdmin(jwt, { id })).toMatchObject({ ok: true, data: { name: "馬克杯", priceTwd: 320 } });
  });

  it("不帶原價代表不變：已有原價時調整其他欄位，原價保留", async () => {
    const jwt = await mintAccessJwt();
    const id = (await createStockedListing("馬克杯", 320, 5)).productId;
    await app.updateProduct(jwt, edit(id, 320, { compareAtPriceTwd: 450 }));

    expect(await app.updateProduct(jwt, edit(id, 330, { name: "大馬克杯" }))).toEqual({ ok: true, data: { id } });

    expect(await compareAtOf(jwt, id)).toBe(450);
  });

  it("不帶原價時把售價調到不低於既有原價：回 invalid_compare_at_price", async () => {
    const jwt = await mintAccessJwt();
    const id = (await createStockedListing("馬克杯", 320, 5)).productId;
    await app.updateProduct(jwt, edit(id, 320, { compareAtPriceTwd: 450 }));

    expect(await app.updateProduct(jwt, edit(id, 450))).toEqual({ ok: false, reason: "invalid_compare_at_price" });
    expect(await app.getProductForAdmin(jwt, { id })).toMatchObject({ ok: true, data: { priceTwd: 320, compareAtPriceTwd: 450 } });
  });

  it("帶 null 清空原價，結束特價", async () => {
    const jwt = await mintAccessJwt();
    const id = (await createStockedListing("馬克杯", 320, 5)).productId;
    await app.updateProduct(jwt, edit(id, 320, { compareAtPriceTwd: 450 }));

    expect(await app.updateProduct(jwt, edit(id, 320, { compareAtPriceTwd: null }))).toEqual({ ok: true, data: { id } });

    expect(await compareAtOf(jwt, id)).toBeNull();
    expect(await hasSale()).toEqual({ ok: true, data: false });
  });

  it("同一次儲存把售價改回原價並清空原價是合法的", async () => {
    const jwt = await mintAccessJwt();
    const id = (await createStockedListing("馬克杯", 320, 5)).productId;
    await app.updateProduct(jwt, edit(id, 320, { compareAtPriceTwd: 450 }));

    expect(await app.updateProduct(jwt, edit(id, 450, { compareAtPriceTwd: null }))).toEqual({ ok: true, data: { id } });

    expect(await app.getProductForAdmin(jwt, { id })).toMatchObject({ ok: true, data: { priceTwd: 450, compareAtPriceTwd: null } });
  });

  it("同一次儲存調整售價與原價，以儲存後的結果檢查", async () => {
    const jwt = await mintAccessJwt();
    const id = (await createStockedListing("馬克杯", 320, 5)).productId;
    await app.updateProduct(jwt, edit(id, 320, { compareAtPriceTwd: 450 }));

    expect(await app.updateProduct(jwt, edit(id, 600, { compareAtPriceTwd: 800 }))).toEqual({ ok: true, data: { id } });
    expect(await app.getProductForAdmin(jwt, { id })).toMatchObject({ ok: true, data: { priceTwd: 600, compareAtPriceTwd: 800 } });
  });

  it.each([[0], [-1], [1.5], [Number.NaN], ["abc"]])("原價 %j 不是正整數：回 invalid_input", async (compareAt) => {
    const jwt = await mintAccessJwt();
    const id = (await createStockedListing("馬克杯", 320, 5)).productId;

    const result = await app.updateProduct(jwt, edit(id, 320, { compareAtPriceTwd: compareAt }));

    expect(result).toMatchObject({ ok: false, reason: "invalid_input", fields: { compareAtPriceTwd: [expect.any(String)] } });
  });

  it("不存在的商品回 product_not_found", async () => {
    const jwt = await mintAccessJwt();
    expect(await app.updateProduct(jwt, edit(9999, 320, { compareAtPriceTwd: 450 }))).toEqual({ ok: false, reason: "product_not_found" });
  });

  it("不存在的商品帶非法原價：先回 product_not_found，不是 invalid_compare_at_price", async () => {
    const jwt = await mintAccessJwt();
    expect(await app.updateProduct(jwt, edit(9999, 320, { compareAtPriceTwd: 100 }))).toEqual({ ok: false, reason: "product_not_found" });
  });

  it("未授權被拒，且沒有寫入", async () => {
    const jwt = await mintAccessJwt();
    const id = (await createStockedListing("馬克杯", 320, 5)).productId;

    expect(await app.updateProduct("", edit(id, 320, { compareAtPriceTwd: 450 }))).toEqual({ ok: false, reason: "unauthorized" });

    expect(await compareAtOf(jwt, id)).toBeNull();
  });
});

describe("只看特價與特價入口", () => {
  beforeEach(resetDb);

  async function onSale(name: string, priceTwd: number, compareAtPriceTwd: number, stock = 5) {
    const jwt = await mintAccessJwt();
    const id = (await createStockedListing(name, priceTwd, stock)).productId;
    const updated = await app.updateProduct(jwt, { id, name, description: "說明", priceTwd, compareAtPriceTwd });
    if (!updated.ok) throw new Error(`設定原價失敗：${updated.reason}`);
    return id;
  }

  it("onSale 只列上架中且有原價的商品，總件數一致", async () => {
    (await createStockedListing("平價杯", 100, 5)).productId;
    await onSale("特價杯", 80, 100);

    expect(await listedNames({ onSale: true })).toEqual(["特價杯"]);
    expect(await app.listProducts({ onSale: true })).toMatchObject({ ok: true, data: { total: 1, hasMore: false } });
    expect(await listedNames({ onSale: false })).toHaveLength(2);
    expect(await listedNames()).toHaveLength(2);
  });

  it("下架的特價商品不出現在特價列表", async () => {
    const jwt = await mintAccessJwt();
    const id = await onSale("特價杯", 80, 100);
    await app.unlistProduct(jwt, { id });

    expect(await listedNames({ onSale: true })).toEqual([]);
  });

  it("onSale 可與只看有貨、分類與排序組合", async () => {
    await onSale("特價貴", 900, 1000, 5);
    await onSale("特價便宜", 80, 100, 5);
    await onSale("特價售完", 50, 100, 0);
    (await createStockedListing("原價品", 10, 5)).productId;

    expect(await listedNames({ onSale: true, inStock: true, sort: "price-asc" })).toEqual(["特價便宜", "特價貴"]);
    expect(await listedNames({ onSale: true, sort: "price-desc" })).toEqual(["特價貴", "特價便宜", "特價售完"]);
    expect(await listedNames({ onSale: true, category: "default" })).toHaveLength(3);
    expect(await listedNames({ onSale: true, category: "other" })).toEqual([]);
  });

  it("onSale 不是布林值：回 invalid_input", async () => {
    expect(await app.listProducts({ onSale: "yes" })).toMatchObject({ ok: false, reason: "invalid_input" });
  });

  it("getStorefrontNav 的 hasSale：無特價為 false、有為 true、特價商品下架後回到 false", async () => {
    const jwt = await mintAccessJwt();
    expect(await hasSale()).toEqual({ ok: true, data: false });

    (await createStockedListing("平價杯", 100, 5)).productId;
    expect(await hasSale()).toEqual({ ok: true, data: false });

    const id = await onSale("特價杯", 80, 100);
    expect(await hasSale()).toEqual({ ok: true, data: true });

    await app.unlistProduct(jwt, { id });
    expect(await hasSale()).toEqual({ ok: true, data: false });
  });
});

describe("導覽資料", () => {
  beforeEach(resetDb);

  it("一次回傳有上架商品的分類與是否有特價商品", async () => {
    const jwt = await mintAccessJwt();
    expect(await app.getStorefrontNav()).toEqual({ ok: true, data: { categories: [], hasSale: false } });

    const id = (await createStockedListing("馬克杯", 320, 5)).productId;
    await app.updateProduct(jwt, edit(id, 320, { compareAtPriceTwd: 450 }));

    expect(await app.getStorefrontNav()).toMatchObject({ ok: true, data: { categories: [{ slug: "default" }], hasSale: true } });
  });
});

describe("結帳的價格比對不看原價", () => {
  beforeEach(resetDb);

  it("購物車單價高於目前售價（降價）：以 price_changed 擋下並告知新價格", async () => {
    const { productId: id, variantId } = await createStockedListing("馬克杯", 320, 10);
    const cookie = await signInCustomer("alice");
    await app.updateProduct(await mintAccessJwt(), edit(id, 250, { compareAtPriceTwd: 320 }));

    expect(await app.checkout(cookie, checkoutInput([{ variantId, quantity: 1, seenUnitPriceTwd: 320 }]))).toEqual({
      ok: false,
      reason: "checkout_rejected",
      issues: [{ variantId, kind: "price_changed", currentUnitPriceTwd: 250 }],
    });
  });

  it("以售價結帳成功，訂單只記成交單價", async () => {
    const { productId: id, variantId } = await createStockedListing("馬克杯", 320, 10);
    const cookie = await signInCustomer("alice");
    await app.updateProduct(await mintAccessJwt(), edit(id, 250, { compareAtPriceTwd: 320 }));

    const placed = await app.checkout(cookie, checkoutInput([{ variantId, quantity: 1, seenUnitPriceTwd: 250 }]));
    if (!placed.ok) throw new Error(`結帳失敗：${placed.reason}`);
    const order = await app.getMyOrder(cookie, { orderId: placed.data.orderId });
    expect(order).toMatchObject({ ok: true, data: { lines: [{ productId: id, variantId, unitPriceTwd: 250 }] } });
    expect(JSON.stringify(order)).not.toContain("ompareAt");
  });
});
