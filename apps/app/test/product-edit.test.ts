import { exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { mintAccessJwt } from "./access";
import { resetDb } from "./db";

const app = exports.default;

/** 新增一個商品並回傳它的 id；新增商品的行為由 products.test.ts 驗證。 */
async function createMug(jwt: string) {
  const created = await app.createProduct(jwt, { name: "馬克杯", description: "350ml 陶瓷杯", priceTwd: 320 });
  if (!created.ok) throw new Error("新增商品失敗");
  return created.data.id;
}

describe("修改商品", () => {
  beforeEach(resetDb);

  it("管理員修改名稱、說明與單價後，前台看到新內容", async () => {
    const jwt = await mintAccessJwt();
    const id = await createMug(jwt);

    const result = await app.updateProduct(jwt, { id, name: "大馬克杯", description: "500ml", priceTwd: 450 });
    expect(result).toEqual({ ok: true, data: { id } });

    expect(await app.listProducts()).toEqual({
      ok: true,
      data: [{ id, name: "大馬克杯", description: "500ml", priceTwd: 450, purchasable: false }],
    });
  });

  it("修改不存在的商品回 product_not_found", async () => {
    const jwt = await mintAccessJwt();
    const result = await app.updateProduct(jwt, { id: 9999, name: "x", description: "", priceTwd: 1 });
    expect(result).toEqual({ ok: false, reason: "product_not_found" });
  });
});

describe("下架與重新上架", () => {
  beforeEach(resetDb);

  it("下架的商品不出現在前台，但仍列在後台", async () => {
    const jwt = await mintAccessJwt();
    const id = await createMug(jwt);

    expect(await app.unlistProduct(jwt, { id })).toEqual({ ok: true, data: { id } });

    expect(await app.listProducts()).toEqual({ ok: true, data: [] });
    expect(await app.listProductsForAdmin(jwt)).toEqual({
      ok: true,
      data: [expect.objectContaining({ id, name: "馬克杯", listed: false })],
    });
  });

  it("下架不存在的商品回 product_not_found", async () => {
    const jwt = await mintAccessJwt();
    expect(await app.unlistProduct(jwt, { id: 9999 })).toEqual({ ok: false, reason: "product_not_found" });
  });

  it("已下架的商品可以重新上架，回到前台且內容不變", async () => {
    const jwt = await mintAccessJwt();
    const id = await createMug(jwt);
    await app.unlistProduct(jwt, { id });

    expect(await app.relistProduct(jwt, { id })).toEqual({ ok: true, data: { id } });

    expect(await app.listProducts()).toEqual({
      ok: true,
      data: [{ id, name: "馬克杯", description: "350ml 陶瓷杯", priceTwd: 320, purchasable: false }],
    });
  });

  it("重新上架不存在的商品回 product_not_found", async () => {
    const jwt = await mintAccessJwt();
    expect(await app.relistProduct(jwt, { id: 9999 })).toEqual({ ok: false, reason: "product_not_found" });
  });

  it("重複下架、重複上架都是冪等的成功", async () => {
    const jwt = await mintAccessJwt();
    const id = await createMug(jwt);

    expect((await app.relistProduct(jwt, { id })).ok).toBe(true);
    await app.unlistProduct(jwt, { id });
    expect((await app.unlistProduct(jwt, { id })).ok).toBe(true);
    expect(await app.listProducts()).toEqual({ ok: true, data: [] });
  });

  it("修改已下架的商品不會讓它重新上架", async () => {
    const jwt = await mintAccessJwt();
    const id = await createMug(jwt);
    await app.unlistProduct(jwt, { id });

    await app.updateProduct(jwt, { id, name: "大馬克杯", description: "", priceTwd: 450 });

    expect(await app.listProducts()).toEqual({ ok: true, data: [] });
    expect(await app.listProductsForAdmin(jwt)).toEqual({
      ok: true,
      data: [expect.objectContaining({ id, name: "大馬克杯", priceTwd: 450, listed: false })],
    });
  });
});

describe("讀取單一商品（編輯頁用）", () => {
  beforeEach(resetDb);

  it("回傳商品內容與上架狀態，包含已下架的", async () => {
    const jwt = await mintAccessJwt();
    const id = await createMug(jwt);
    expect(await app.getProductForAdmin(jwt, { id })).toEqual({
      ok: true,
      data: { id, name: "馬克杯", description: "350ml 陶瓷杯", priceTwd: 320, listed: true, onHand: 0, reserved: 0, available: 0 },
    });

    await app.unlistProduct(jwt, { id });
    expect(await app.getProductForAdmin(jwt, { id })).toMatchObject({ ok: true, data: { listed: false } });
  });

  it("不存在的商品回 product_not_found", async () => {
    const jwt = await mintAccessJwt();
    expect(await app.getProductForAdmin(jwt, { id: 9999 })).toEqual({ ok: false, reason: "product_not_found" });
  });

  it("沒有有效 Access JWT 被拒絕", async () => {
    const jwt = await mintAccessJwt();
    const id = await createMug(jwt);
    expect(await app.getProductForAdmin("", { id })).toEqual({ ok: false, reason: "unauthorized" });
  });

  it("商品編號無效被拒絕，訊息用「商品編號」", async () => {
    const jwt = await mintAccessJwt();
    expect(await app.getProductForAdmin(jwt, { id: "1" })).toEqual({
      ok: false,
      reason: "invalid_input",
      fields: { id: ["商品編號必須是數字"] },
    });
  });
});

describe("修改、下架、上架的守門", () => {
  beforeEach(resetDb);

  it("沒有有效 Access JWT 一律拒絕，且商品不變", async () => {
    const jwt = await mintAccessJwt();
    const id = await createMug(jwt);
    const unauthorized = { ok: false, reason: "unauthorized" };

    expect(await app.updateProduct("", { id, name: "駭入", description: "", priceTwd: 1 })).toEqual(unauthorized);
    expect(await app.unlistProduct("", { id })).toEqual(unauthorized);
    await app.unlistProduct(jwt, { id });
    expect(await app.relistProduct("", { id })).toEqual(unauthorized);

    expect(await app.listProductsForAdmin(jwt)).toEqual({
      ok: true,
      data: [expect.objectContaining({ name: "馬克杯", priceTwd: 320, listed: false })],
    });
  });

  it("修改沿用新增的輸入驗證：空名稱、非正整數單價被拒，且商品不變", async () => {
    const jwt = await mintAccessJwt();
    const id = await createMug(jwt);

    expect(await app.updateProduct(jwt, { id, name: " ", description: "", priceTwd: 320 })).toEqual({
      ok: false,
      reason: "invalid_input",
      fields: { name: ["名稱不可為空"] },
    });
    expect(await app.updateProduct(jwt, { id, name: "馬克杯", description: "", priceTwd: 0 })).toMatchObject({
      ok: false,
      reason: "invalid_input",
      fields: { priceTwd: [expect.any(String)] },
    });
    expect(await app.listProducts()).toEqual({
      ok: true,
      data: [{ id, name: "馬克杯", description: "350ml 陶瓷杯", priceTwd: 320, purchasable: false }],
    });
  });

  it("商品編號無效被拒絕，帶 invalid_input", async () => {
    const jwt = await mintAccessJwt();
    for (const id of [0, -1, 1.5, "1"]) {
      expect(await app.unlistProduct(jwt, { id })).toMatchObject({ ok: false, reason: "invalid_input" });
    }
  });
});
