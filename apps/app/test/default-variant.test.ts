import { exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { mintAccessJwt } from "./access";
import { checkoutInput, createStockedListing, defaultVariantIdOf, SHIPPING_INFO } from "./checkout-helpers";
import { signInCustomer } from "./customers";
import { resetDb } from "./db";
import { placeMugOrder, stockOf } from "./payment-helpers";

const app = exports.default;

describe("預設變體是販售單位", () => {
  beforeEach(resetDb);

  it("新增商品同時建立一個預設變體，後台與前台都帶出它的編號、售價與庫存", async () => {
    const jwt = await mintAccessJwt();
    const { productId, variantId } = await createStockedListing("馬克杯", 320, 6);

    expect(await app.getProductForAdmin(jwt, { id: productId })).toMatchObject({
      ok: true, data: { defaultVariantId: variantId, priceTwd: 320, onHand: 6, available: 6 },
    });
    expect(await app.getProduct({ id: productId })).toMatchObject({ ok: true, data: { variants: [{ id: variantId, isDefault: true, optionValues: [], priceTwd: 320, compareAtPriceTwd: null, available: 6, imageId: null }] } });
  });

  it("商品與預設變體同時存在：改價、庫存調整都落在預設變體上，且互不影響其他商品", async () => {
    const jwt = await mintAccessJwt();
    const mug = await createStockedListing("馬克杯", 320, 6);
    const pen = await createStockedListing("原子筆", 45, 9);

    await app.updateProduct(jwt, { id: mug.productId, name: "馬克杯", description: "新", priceTwd: 350 });
    await app.adjustStock(jwt, { variantId: mug.variantId, delta: -1, reason: "測試調整" });

    expect(await app.getProductForAdmin(jwt, { id: mug.productId })).toMatchObject({ ok: true, data: { priceTwd: 350, onHand: 5 } });
    expect(await app.getProductForAdmin(jwt, { id: pen.productId })).toMatchObject({ ok: true, data: { priceTwd: 45, onHand: 9 } });
  });

  it("改價與原價檢查是全有全無：原價不合法時商品名稱與價格都不變", async () => {
    const jwt = await mintAccessJwt();
    const { productId } = await createStockedListing("馬克杯", 320, 1);
    await app.updateProduct(jwt, { id: productId, name: "馬克杯", description: "", priceTwd: 320, compareAtPriceTwd: 400 });

    const rejected = await app.updateProduct(jwt, { id: productId, name: "改名", description: "", priceTwd: 450 });

    expect(rejected).toEqual({ ok: false, reason: "invalid_compare_at_price" });
    expect(await app.getProductForAdmin(jwt, { id: productId })).toMatchObject({ ok: true, data: { name: "馬克杯", priceTwd: 320, compareAtPriceTwd: 400 } });
  });

  it("結帳用變體編號：訂單明細記下變體與商品，下單保留的是該變體的可售數量", async () => {
    const alice = await signInCustomer("alice");
    const { variantId, orderId } = await placeMugOrder(alice, { onHand: 5, quantity: 2 });

    const order = await app.getMyOrder(alice, { orderId });
    expect(order).toMatchObject({ ok: true, data: { lines: [{ variantId, productName: "馬克杯", quantity: 2, unitPriceTwd: 320 }] } });
    expect(await stockOf(variantId)).toEqual({ onHand: 5, available: 3 });
  });

  it("結帳帶商品編號當作變體編號不會誤中：變體編號不存在回 variant_not_found", async () => {
    const alice = await signInCustomer("alice");
    const { productId, variantId } = await createStockedListing("馬克杯", 320, 5);
    const absent = Math.max(productId, variantId) + 100;

    expect(await app.checkout(alice, checkoutInput([{ variantId: absent, quantity: 1, seenUnitPriceTwd: 320 }]))).toEqual({
      ok: false, reason: "checkout_rejected", issues: [{ variantId: absent, kind: "variant_not_found" }],
    });
  });

  it("同一個變體在一張訂單中不可重複", async () => {
    const alice = await signInCustomer("alice");
    const variantId = await defaultVariantIdOf((await createStockedListing("馬克杯", 320, 5)).productId);
    const line = { variantId, quantity: 1, seenUnitPriceTwd: 320 };

    expect(await app.checkout(alice, { lines: [line, line], shippingInfo: SHIPPING_INFO, idempotencyKey: "dup-key-0000000001" })).toMatchObject({
      ok: false, reason: "invalid_input",
    });
  });
});
