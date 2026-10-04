import { exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { mintAccessJwt } from "./access";
import { resetDb } from "./db";
import { uploadAndList } from "./images";

const app = exports.default;

/** 新增一個商品並回傳它的 id；新增商品的行為由 products.test.ts 驗證。 */
async function createMug(jwt: string) {
  const created = await app.createProduct(jwt, { name: "馬克杯", description: "350ml 陶瓷杯", priceTwd: 320 });
  if (!created.ok) throw new Error("新增商品失敗");
  await uploadAndList(jwt, created.data.id);
  return created.data.id;
}

/** 對商品的預設變體調整庫存（庫存以變體為單位）。 */
async function adjust(jwt: string, productId: number, delta: unknown) {
  const found = await app.getProductForAdmin(jwt, { id: productId });
  if (!found.ok) throw new Error("讀取商品失敗");
  return app.adjustStock(jwt, { variantId: found.data.defaultVariantId, delta, reason: "測試調整" });
}

describe("在庫數與可售數量", () => {
  beforeEach(resetDb);

  it("新增商品的在庫數與可售數量都是 0，後台看得到", async () => {
    const jwt = await mintAccessJwt();
    const id = await createMug(jwt);

    expect(await app.listProductsForAdmin(jwt)).toEqual({
      ok: true,
      data: [expect.objectContaining({ id, onHand: 0, available: 0 })],
    });
    expect(await app.getProductForAdmin(jwt, { id })).toMatchObject({ ok: true, data: { onHand: 0, available: 0 } });
  });
});

describe("庫存調整", () => {
  beforeEach(resetDb);

  it("補貨 +20 後回傳調整後的在庫數與可售數量，後台與前台都反映", async () => {
    const jwt = await mintAccessJwt();
    const id = await createMug(jwt);

    expect(await adjust(jwt, id, 20)).toEqual({ ok: true, data: { onHand: 20, available: 20 } });

    expect(await app.getProductForAdmin(jwt, { id })).toMatchObject({ ok: true, data: { onHand: 20, available: 20 } });
    expect(await app.listProducts()).toEqual({ ok: true, data: { items: [expect.objectContaining({ id, purchasable: true })], total: 1, hasMore: false } });
  });

  it("扣減量在庫數以內可以成功，扣到剛好 0 也可以", async () => {
    const jwt = await mintAccessJwt();
    const id = await createMug(jwt);
    await adjust(jwt, id, 5);

    expect(await adjust(jwt, id, -3)).toEqual({ ok: true, data: { onHand: 2, available: 2 } });
    expect(await adjust(jwt, id, -2)).toEqual({ ok: true, data: { onHand: 0, available: 0 } });
  });

  it("會讓在庫數變負數的調整被拒絕（insufficient_stock），在庫數不變", async () => {
    const jwt = await mintAccessJwt();
    const id = await createMug(jwt);
    await adjust(jwt, id, 5);

    expect(await adjust(jwt, id, -6)).toEqual({ ok: false, reason: "insufficient_stock" });

    expect(await app.getProductForAdmin(jwt, { id })).toMatchObject({ ok: true, data: { onHand: 5, available: 5 } });
  });

  it("調整不存在的變體回 variant_not_found，與庫存不足可以區分", async () => {
    const jwt = await mintAccessJwt();
    expect(await app.adjustStock(jwt, { variantId: 9999, delta: 5, reason: "測試調整" })).toEqual({ ok: false, reason: "variant_not_found" });
    expect(await app.adjustStock(jwt, { variantId: 9999, delta: -5, reason: "測試調整" })).toEqual({ ok: false, reason: "variant_not_found" });
  });

  it("沒有有效 Access JWT 被拒絕，且在庫數不變", async () => {
    const jwt = await mintAccessJwt();
    const id = await createMug(jwt);

    expect(await app.adjustStock("", { variantId: 1, delta: 20, reason: "測試調整" })).toEqual({ ok: false, reason: "unauthorized" });

    expect(await app.getProductForAdmin(jwt, { id })).toMatchObject({ ok: true, data: { onHand: 0 } });
  });

  it.each([
    ["零", 0],
    ["小數", 1.5],
    ["字串", "20"],
    ["NaN", Number.NaN],
    ["過大", 1_000_001],
  ])("增減量為%s被拒絕，帶 invalid_input 與 delta 欄位錯誤，且在庫數不變", async (_label, delta) => {
    const jwt = await mintAccessJwt();
    const id = await createMug(jwt);

    expect(await adjust(jwt, id, delta)).toMatchObject({
      ok: false,
      reason: "invalid_input",
      fields: { delta: [expect.any(String)] },
    });

    expect(await app.getProductForAdmin(jwt, { id })).toMatchObject({ ok: true, data: { onHand: 0 } });
  });

  it("變體編號無效被拒絕，帶 invalid_input", async () => {
    const jwt = await mintAccessJwt();
    expect(await app.adjustStock(jwt, { variantId: 0, delta: 1, reason: "測試調整" })).toMatchObject({
      ok: false,
      reason: "invalid_input",
      fields: { variantId: [expect.any(String)] },
    });
  });
});

describe("庫存調整的並行", () => {
  beforeEach(resetDb);

  it("同時進行的多個增減不互相覆蓋，最終在庫數等於總和", async () => {
    const jwt = await mintAccessJwt();
    const id = await createMug(jwt);
    await adjust(jwt, id, 100);
    const deltas = [20, -3, 7, -10, 15, -1, 4, 2];

    const results = await Promise.all(deltas.map((delta) => adjust(jwt, id, delta)));

    expect(results.every((result) => result.ok)).toBe(true);
    const total = 100 + deltas.reduce((sum, delta) => sum + delta, 0);
    expect(await app.getProductForAdmin(jwt, { id })).toMatchObject({ ok: true, data: { onHand: total, available: total } });
  });

  it("兩個同時的扣減合計會變負數時，只有會讓它變負數的那個被拒", async () => {
    const jwt = await mintAccessJwt();
    const id = await createMug(jwt);
    await adjust(jwt, id, 5);

    const results = await Promise.all([adjust(jwt, id, -3), adjust(jwt, id, -3)]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, reason: "insufficient_stock" }]);
    expect(await app.getProductForAdmin(jwt, { id })).toMatchObject({ ok: true, data: { onHand: 2 } });
  });

  it("大量同時扣減：在庫 10、同時 20 個 -3，恰好 3 個成功，其餘被拒，在庫數為 1 而不是負數", async () => {
    const jwt = await mintAccessJwt();
    const id = await createMug(jwt);
    await adjust(jwt, id, 10);

    const results = await Promise.all(Array.from({ length: 20 }, () => adjust(jwt, id, -3)));

    expect(results.filter((result) => result.ok)).toHaveLength(3);
    expect(results.filter((result) => !result.ok)).toEqual(
      Array.from({ length: 17 }, () => ({ ok: false, reason: "insufficient_stock" })),
    );
    expect(await app.getProductForAdmin(jwt, { id })).toMatchObject({ ok: true, data: { onHand: 1, available: 1 } });
  });
});
