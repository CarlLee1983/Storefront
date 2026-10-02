import { exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { mintAccessJwt } from "./access";
import { defaultVariantIdOf } from "./checkout-helpers";
import { resetDb } from "./db";
import { imageVariants } from "./images";
import { createOptionListing } from "./variant-helpers";

const app = exports.default;

async function createPlainProduct(jwt: string, name = "餐桌") {
  const created = await app.createProduct(jwt, { name, description: "", priceTwd: 1000 });
  if (!created.ok) throw new Error("新增商品失敗");
  return created.data.id;
}

describe("選項維度與變體管理", () => {
  beforeEach(resetDb);

  it("新商品沒有選項；設定一個選項維度時，預設變體取得選項值", async () => {
    const jwt = await mintAccessJwt();
    const productId = await createPlainProduct(jwt);
    expect(await app.getProductForAdmin(jwt, { id: productId })).toMatchObject({ ok: true, data: { optionNames: [], variants: [expect.objectContaining({ isDefault: true, optionValues: [] })] } });

    expect(await app.setProductOptions(jwt, { id: productId, optionNames: ["顏色"], defaultVariantValues: ["胡桃色"] })).toEqual({ ok: true, data: { id: productId } });

    expect(await app.getProductForAdmin(jwt, { id: productId })).toMatchObject({
      ok: true, data: { optionNames: ["顏色"], variants: [expect.objectContaining({ isDefault: true, optionValues: ["胡桃色"], priceTwd: 1000 })] },
    });
  });

  it("最多兩個選項維度，名稱不可重複或為空，選項值個數要與維度一致", async () => {
    const jwt = await mintAccessJwt();
    const productId = await createPlainProduct(jwt);

    expect(await app.setProductOptions(jwt, { id: productId, optionNames: ["顏色", "尺寸", "材質"], defaultVariantValues: ["a", "b", "c"] })).toMatchObject({ ok: false, reason: "invalid_input" });
    expect(await app.setProductOptions(jwt, { id: productId, optionNames: ["顏色", "顏色"], defaultVariantValues: ["a", "b"] })).toMatchObject({ ok: false, reason: "invalid_input" });
    expect(await app.setProductOptions(jwt, { id: productId, optionNames: ["顏色", " "], defaultVariantValues: ["a", "b"] })).toMatchObject({ ok: false, reason: "invalid_input" });
    expect(await app.setProductOptions(jwt, { id: productId, optionNames: ["顏色", "尺寸"], defaultVariantValues: ["a"] })).toEqual({ ok: false, reason: "option_count_mismatch" });
    expect(await app.getProductForAdmin(jwt, { id: productId })).toMatchObject({ ok: true, data: { optionNames: [] } });
  });

  it("各變體有獨立的售價、原價與庫存，補貨只影響該變體", async () => {
    const jwt = await mintAccessJwt();
    const { productId, variantIds } = await createOptionListing("餐桌", ["尺寸"], [
      { values: ["120 公分"], priceTwd: 9000, onHand: 3 },
      { values: ["150 公分"], priceTwd: 12000, compareAtPriceTwd: 15000, onHand: 1 },
    ]);

    const admin = await app.getProductForAdmin(jwt, { id: productId });
    expect(admin).toMatchObject({ ok: true, data: { variants: [
      expect.objectContaining({ id: variantIds[0], priceTwd: 9000, compareAtPriceTwd: null, onHand: 3, available: 3 }),
      expect.objectContaining({ id: variantIds[1], priceTwd: 12000, compareAtPriceTwd: 15000, onHand: 1, available: 1 }),
    ] } });
  });

  it("同商品的選項值組合不可重複，沒有選項的商品不能新增變體", async () => {
    const jwt = await mintAccessJwt();
    const { productId } = await createOptionListing("餐桌", ["尺寸"], [{ values: ["120 公分"], priceTwd: 9000, onHand: 1 }]);
    expect(await app.createVariant(jwt, { productId, optionValues: ["120 公分"], priceTwd: 9500 })).toEqual({ ok: false, reason: "duplicate_variant" });
    expect(await app.createVariant(jwt, { productId, optionValues: ["a", "b"], priceTwd: 9500 })).toEqual({ ok: false, reason: "option_count_mismatch" });

    const plain = await createPlainProduct(jwt, "椅子");
    expect(await app.createVariant(jwt, { productId: plain, optionValues: [], priceTwd: 500 })).toEqual({ ok: false, reason: "option_count_mismatch" });
    expect(await app.createVariant(jwt, { productId: 999999, optionValues: ["x"], priceTwd: 500 })).toEqual({ ok: false, reason: "product_not_found" });
  });

  it("原價必須高於售價：新增與修改都檢查，改價時不帶原價也不能讓既有原價失效", async () => {
    const jwt = await mintAccessJwt();
    const { productId, variantIds } = await createOptionListing("餐桌", ["尺寸"], [
      { values: ["120 公分"], priceTwd: 9000, onHand: 1 },
      { values: ["150 公分"], priceTwd: 12000, compareAtPriceTwd: 15000, onHand: 1 },
    ]);
    expect(await app.createVariant(jwt, { productId, optionValues: ["180 公分"], priceTwd: 1000, compareAtPriceTwd: 1000 })).toEqual({ ok: false, reason: "invalid_compare_at_price" });

    expect(await app.updateVariant(jwt, { variantId: variantIds[1], optionValues: ["150 公分"], priceTwd: 16000 })).toEqual({ ok: false, reason: "invalid_compare_at_price" });
    expect(await app.updateVariant(jwt, { variantId: variantIds[1], optionValues: ["150 公分"], priceTwd: 16000, compareAtPriceTwd: null })).toMatchObject({ ok: true });
    expect(await app.getProductForAdmin(jwt, { id: productId })).toMatchObject({ ok: true, data: { variants: [expect.anything(), expect.objectContaining({ priceTwd: 16000, compareAtPriceTwd: null })] } });
  });

  it("修改變體可改選項值；改成與別的變體相同的組合被拒絕", async () => {
    const jwt = await mintAccessJwt();
    const { variantIds } = await createOptionListing("餐桌", ["尺寸"], [
      { values: ["120 公分"], priceTwd: 9000, onHand: 0 },
      { values: ["150 公分"], priceTwd: 12000, onHand: 0 },
    ]);
    expect(await app.updateVariant(jwt, { variantId: variantIds[1], optionValues: ["120 公分"], priceTwd: 12000 })).toEqual({ ok: false, reason: "duplicate_variant" });
    expect(await app.updateVariant(jwt, { variantId: variantIds[1], optionValues: ["160 公分"], priceTwd: 12000 })).toMatchObject({ ok: true });
    expect(await app.updateVariant(jwt, { variantId: 999999, optionValues: ["x"], priceTwd: 100 })).toEqual({ ok: false, reason: "variant_not_found" });
  });

  it("變體可指定同商品的一張圖片；別的商品的圖片不行，刪除圖片後指定會清空", async () => {
    const jwt = await mintAccessJwt();
    const { productId, variantIds } = await createOptionListing("餐桌", ["尺寸"], [
      { values: ["120 公分"], priceTwd: 9000, onHand: 1 },
      { values: ["150 公分"], priceTwd: 12000, onHand: 1 },
    ]);
    const second = await app.addProductImage(jwt, { id: productId, uploadId: crypto.randomUUID(), variants: imageVariants() });
    if (!second.ok) throw new Error("上傳失敗");
    const other = await createOptionListing("椅子", ["顏色"], [{ values: ["白"], priceTwd: 500, onHand: 1 }]);

    expect(await app.updateVariant(jwt, { variantId: variantIds[1], optionValues: ["150 公分"], priceTwd: 12000, imageId: other.imageId })).toEqual({ ok: false, reason: "image_not_found" });
    expect(await app.updateVariant(jwt, { variantId: variantIds[1], optionValues: ["150 公分"], priceTwd: 12000, imageId: second.data.image.id })).toMatchObject({ ok: true });
    expect(await app.getProductForAdmin(jwt, { id: productId })).toMatchObject({ ok: true, data: { variants: [expect.objectContaining({ imageId: null }), expect.objectContaining({ imageId: second.data.image.id })] } });

    expect(await app.deleteProductImage(jwt, { id: productId, imageId: second.data.image.id })).toMatchObject({ ok: true });
    expect(await app.getProductForAdmin(jwt, { id: productId })).toMatchObject({ ok: true, data: { variants: [expect.anything(), expect.objectContaining({ imageId: null })] } });
  });

  it("停賣與恢復販售：變體與歷史保留，重複操作冪等", async () => {
    const jwt = await mintAccessJwt();
    const { productId, variantIds } = await createOptionListing("餐桌", ["尺寸"], [
      { values: ["120 公分"], priceTwd: 9000, onHand: 2 },
      { values: ["150 公分"], priceTwd: 12000, onHand: 2 },
    ]);

    expect(await app.setVariantDiscontinued(jwt, { variantId: variantIds[1], discontinued: true })).toMatchObject({ ok: true });
    expect(await app.setVariantDiscontinued(jwt, { variantId: variantIds[1], discontinued: true })).toMatchObject({ ok: true });
    expect(await app.getProductForAdmin(jwt, { id: productId })).toMatchObject({ ok: true, data: { variants: [expect.objectContaining({ discontinued: false }), expect.objectContaining({ discontinued: true, onHand: 2 })] } });

    expect(await app.setVariantDiscontinued(jwt, { variantId: variantIds[1], discontinued: false })).toMatchObject({ ok: true });
    expect(await app.getProductForAdmin(jwt, { id: productId })).toMatchObject({ ok: true, data: { variants: [expect.anything(), expect.objectContaining({ discontinued: false })] } });
    expect(await app.setVariantDiscontinued(jwt, { variantId: 999999, discontinued: true })).toEqual({ ok: false, reason: "variant_not_found" });
  });

  it("只有一個變體時可以增減維度個數；已有多個變體時只能改名稱", async () => {
    const jwt = await mintAccessJwt();
    const { productId } = await createOptionListing("餐桌", ["尺寸"], [
      { values: ["120 公分"], priceTwd: 9000, onHand: 0 },
      { values: ["150 公分"], priceTwd: 12000, onHand: 0 },
    ]);

    expect(await app.setProductOptions(jwt, { id: productId, optionNames: ["桌面寬度"] })).toMatchObject({ ok: true });
    expect(await app.getProductForAdmin(jwt, { id: productId })).toMatchObject({ ok: true, data: { optionNames: ["桌面寬度"] } });
    expect(await app.setProductOptions(jwt, { id: productId, optionNames: ["桌面寬度", "顏色"], defaultVariantValues: ["120 公分", "白"] })).toEqual({ ok: false, reason: "options_locked" });
    expect(await app.setProductOptions(jwt, { id: productId, optionNames: [], defaultVariantValues: [] })).toEqual({ ok: false, reason: "options_locked" });

    const single = await createPlainProduct(jwt, "椅子");
    await app.setProductOptions(jwt, { id: single, optionNames: ["顏色"], defaultVariantValues: ["白"] });
    expect(await app.setProductOptions(jwt, { id: single, optionNames: [] })).toEqual({ ok: true, data: { id: single } });
    expect(await app.getProductForAdmin(jwt, { id: single })).toMatchObject({ ok: true, data: { optionNames: [], variants: [expect.objectContaining({ optionValues: [] })] } });
    expect(await defaultVariantIdOf(single)).toBeGreaterThan(0);
  });

  it("所有選項與變體管理都要求管理員身分", async () => {
    const { productId, variantIds } = await createOptionListing("餐桌", ["尺寸"], [{ values: ["120 公分"], priceTwd: 9000, onHand: 0 }]);
    const unauthorized = { ok: false, reason: "unauthorized" };

    expect(await app.setProductOptions("", { id: productId, optionNames: [] })).toEqual(unauthorized);
    expect(await app.createVariant("", { productId, optionValues: ["x"], priceTwd: 100 })).toEqual(unauthorized);
    expect(await app.updateVariant("", { variantId: variantIds[0], optionValues: ["x"], priceTwd: 100 })).toEqual(unauthorized);
    expect(await app.setVariantDiscontinued("", { variantId: variantIds[0], discontinued: true })).toEqual(unauthorized);
  });
});
