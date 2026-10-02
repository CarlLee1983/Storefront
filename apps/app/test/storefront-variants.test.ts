import { exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { mintAccessJwt } from "./access";
import { createStockedListing } from "./checkout-helpers";
import { resetDb } from "./db";
import { createOptionListing } from "./variant-helpers";

const app = exports.default;

/** 兩個尺寸、兩個顏色的餐桌：只建立實際販售的三種組合。 */
async function createTable() {
  return createOptionListing("餐桌", ["尺寸", "顏色"], [
    { values: ["120 公分", "胡桃色"], priceTwd: 9000, onHand: 3 },
    { values: ["120 公分", "白橡色"], priceTwd: 9500, compareAtPriceTwd: 11000, onHand: 0 },
    { values: ["150 公分", "胡桃色"], priceTwd: 12000, onHand: 2 },
  ]);
}

describe("前台商品詳情的變體", () => {
  beforeEach(resetDb);

  it("帶出選項維度與每個販售中變體各自的確切價格、可售量與指定圖片，預設變體在前", async () => {
    const jwt = await mintAccessJwt();
    const { productId, variantIds, imageId } = await createTable();
    await app.updateVariant(jwt, { variantId: variantIds[2], optionValues: ["150 公分", "胡桃色"], priceTwd: 12000, imageId });

    expect(await app.getProduct({ id: productId })).toMatchObject({
      ok: true,
      data: {
        optionNames: ["尺寸", "顏色"],
        purchasable: true,
        variants: [
          { id: variantIds[0], isDefault: true, optionValues: ["120 公分", "胡桃色"], priceTwd: 9000, compareAtPriceTwd: null, available: 3, imageId: null },
          { id: variantIds[1], isDefault: false, optionValues: ["120 公分", "白橡色"], priceTwd: 9500, compareAtPriceTwd: 11000, available: 0, imageId: null },
          { id: variantIds[2], isDefault: false, optionValues: ["150 公分", "胡桃色"], priceTwd: 12000, compareAtPriceTwd: null, available: 2, imageId },
        ],
      },
    });
  });

  it("停賣的變體不對顧客出現；全部停賣時沒有變體、不可購買", async () => {
    const jwt = await mintAccessJwt();
    const { productId, variantIds } = await createTable();

    await app.setVariantDiscontinued(jwt, { variantId: variantIds[2], discontinued: true });
    expect(await app.getProduct({ id: productId })).toMatchObject({ ok: true, data: { variants: [{ id: variantIds[0] }, { id: variantIds[1] }] } });

    for (const variantId of variantIds) await app.setVariantDiscontinued(jwt, { variantId, discontinued: true });
    expect(await app.getProduct({ id: productId })).toMatchObject({ ok: true, data: { variants: [], purchasable: false } });
  });

  it("無選項商品仍可用：沒有維度、只有預設變體", async () => {
    const { productId, variantId } = await createStockedListing("馬克杯", 320, 4);
    expect(await app.getProduct({ id: productId })).toMatchObject({
      ok: true, data: { optionNames: [], variants: [{ id: variantId, isDefault: true, optionValues: [], priceTwd: 320, available: 4 }] },
    });
  });
});

describe("前台列表的變體彙總", () => {
  beforeEach(resetDb);

  it("列表價格是販售中變體的範圍，有特價變體時標示有特價選項，並帶出是否有選項", async () => {
    const { productId } = await createTable();
    const plain = await createStockedListing("馬克杯", 320, 4);

    const listed = await app.listProducts();
    expect(listed).toMatchObject({ ok: true, data: { items: expect.arrayContaining([
      expect.objectContaining({ id: productId, hasOptions: true, priceTwd: 9000, maxPriceTwd: 12000, onSale: true, compareAtPriceTwd: null, purchasable: true }),
      expect.objectContaining({ id: plain.productId, hasOptions: false, priceTwd: 320, maxPriceTwd: 320, onSale: false, purchasable: true }),
    ]) } });
  });

  it("停賣的變體不計入價格範圍、特價與可購買；全部停賣時沒有報價且不可購買", async () => {
    const jwt = await mintAccessJwt();
    const { productId, variantIds } = await createTable();

    // 停賣最便宜的預設變體與唯一的特價變體：只剩 150 公分胡桃色
    await app.setVariantDiscontinued(jwt, { variantId: variantIds[0], discontinued: true });
    await app.setVariantDiscontinued(jwt, { variantId: variantIds[1], discontinued: true });
    expect(await app.listProducts()).toMatchObject({ ok: true, data: { items: [{ id: productId, priceTwd: 12000, maxPriceTwd: 12000, onSale: false, purchasable: true }] } });
    expect(await app.listProducts({ onSale: true })).toMatchObject({ ok: true, data: { items: [], total: 0 } });

    await app.setVariantDiscontinued(jwt, { variantId: variantIds[2], discontinued: true });
    expect(await app.listProducts()).toMatchObject({ ok: true, data: { items: [{ id: productId, priceTwd: null, maxPriceTwd: null, onSale: false, purchasable: false }] } });
    expect(await app.getStorefrontNav()).toMatchObject({ ok: true, data: { hasSale: false } });
  });

  it("有貨篩選要求至少一個販售中變體的可售量大於零；售罄或停賣的變體不算", async () => {
    const jwt = await mintAccessJwt();
    const { productId, variantIds } = await createOptionListing("餐桌", ["尺寸"], [
      { values: ["120 公分"], priceTwd: 9000, onHand: 0 },
      { values: ["150 公分"], priceTwd: 12000, onHand: 2 },
    ]);
    expect(await app.listProducts({ inStock: true })).toMatchObject({ ok: true, data: { items: [{ id: productId }] } });

    await app.setVariantDiscontinued(jwt, { variantId: variantIds[1], discontinued: true });
    expect(await app.listProducts({ inStock: true })).toMatchObject({ ok: true, data: { items: [], total: 0 } });
  });

  it("單一變體商品的原價仍在列表上；價格排序依最低的販售中價格", async () => {
    const cheapOptions = await createOptionListing("小邊桌", ["顏色"], [
      { values: ["白"], priceTwd: 800, onHand: 1 },
      { values: ["黑"], priceTwd: 5000, onHand: 1 },
    ]);
    const mug = await createStockedListing("馬克杯", 320, 4);
    const sofa = await createStockedListing("沙發", 20000, 4);
    await app.updateProduct(await mintAccessJwt(), { id: mug.productId, name: "馬克杯", description: "", priceTwd: 320, compareAtPriceTwd: 400 });

    expect(await app.listProducts({ sort: "price-asc" })).toMatchObject({ ok: true, data: { items: [
      { id: mug.productId, compareAtPriceTwd: 400, onSale: true }, { id: cheapOptions.productId }, { id: sofa.productId },
    ] } });
    expect(await app.listProducts({ sort: "price-desc" })).toMatchObject({ ok: true, data: { items: [{ id: sofa.productId }, { id: cheapOptions.productId }, { id: mug.productId }] } });
  });
});
