import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { mintAccessJwt } from "./access";
import { checkoutInput, createStockedListing, newKey } from "./checkout-helpers";
import { signInCustomer } from "./customers";
import { resetDb } from "./db";
import { installFakeGateway } from "./fake-gateway";
import { setNow } from "./clock";
import { orderOf, startPaymentFor } from "./payment-helpers";
import { app } from "./release-helpers";

beforeEach(async () => {
  await resetDb();
  setNow(Date.UTC(2026, 9, 3, 2, 0, 0));
});

async function lamp(onHand = 10) {
  return createStockedListing("燈具", 1000, onHand);
}

async function table(onHand = 10) {
  return createStockedListing("餐桌", 6000, onHand, "large");
}

/** 成立訂單並回傳完整結果；顧客確認的運費合計由呼叫端指定。 */
async function checkout(cookie: string, lines: { variantId: number; quantity: number; seenUnitPriceTwd: number }[], seenShippingTwd: number, key = newKey()) {
  return app.checkout(cookie, checkoutInput(lines, key, seenShippingTwd));
}

describe("依配送類型計費", () => {
  it("只有一般宅配：收一般運費 100，同類多件、多筆明細也只收一次", async () => {
    const alice = await signInCustomer("alice");
    const a = await lamp();
    const b = await createStockedListing("杯子", 200, 10);

    const result = await checkout(alice, [
      { variantId: a.variantId, quantity: 3, seenUnitPriceTwd: 1000 },
      { variantId: b.variantId, quantity: 2, seenUnitPriceTwd: 200 },
    ], 100);

    expect(result).toMatchObject({ ok: true, data: { totalTwd: 3400 + 100 } });
    if (!result.ok) return;
    expect(await orderOf(alice, result.data.orderId)).toMatchObject({ totalTwd: 3500, shippingFees: { standard: 100, large: 0 } });
  });

  it("只有大型配送：收大型運費 600", async () => {
    const alice = await signInCustomer("alice");
    const big = await table();

    const result = await checkout(alice, [{ variantId: big.variantId, quantity: 2, seenUnitPriceTwd: 6000 }], 600);

    expect(result).toMatchObject({ ok: true, data: { totalTwd: 12600 } });
    if (!result.ok) return;
    expect(await orderOf(alice, result.data.orderId)).toMatchObject({
      shippingFees: { standard: 0, large: 600 },
      lines: [{ deliveryType: "large", unitPriceTwd: 6000, quantity: 2 }],
    });
  });

  it("混合兩類：各收一次共 700，明細各自保留配送類型", async () => {
    const alice = await signInCustomer("alice");
    const small = await lamp();
    const big = await table();

    const result = await checkout(alice, [
      { variantId: small.variantId, quantity: 3, seenUnitPriceTwd: 1000 },
      { variantId: big.variantId, quantity: 1, seenUnitPriceTwd: 6000 },
    ], 700);

    expect(result).toMatchObject({ ok: true, data: { totalTwd: 9700 } });
    if (!result.ok) return;
    expect(await orderOf(alice, result.data.orderId)).toMatchObject({
      shippingFees: { standard: 100, large: 600 },
      lines: [{ variantId: small.variantId, deliveryType: "standard" }, { variantId: big.variantId, deliveryType: "large" }],
    });
  });

  it("顧客確認的運費與現行不符就拒絕，回報現行運費且不保留庫存", async () => {
    const alice = await signInCustomer("alice");
    const big = await table(1);

    const result = await checkout(alice, [{ variantId: big.variantId, quantity: 1, seenUnitPriceTwd: 6000 }], 100);

    expect(result).toEqual({ ok: false, reason: "shipping_fee_changed", currentShippingTwd: 600 });
    expect(await checkout(alice, [{ variantId: big.variantId, quantity: 1, seenUnitPriceTwd: 6000 }], 600)).toMatchObject({ ok: true });
  });

  it("運費不符與商品問題同時存在時先回報商品問題", async () => {
    const alice = await signInCustomer("alice");
    const small = await lamp(0);

    expect(await checkout(alice, [{ variantId: small.variantId, quantity: 1, seenUnitPriceTwd: 1000 }], 999))
      .toMatchObject({ ok: false, reason: "checkout_rejected", issues: [{ kind: "insufficient_stock" }] });
  });

  it("負數或非整數的運費是無效輸入", async () => {
    const alice = await signInCustomer("alice");
    const small = await lamp();
    const lines = [{ variantId: small.variantId, quantity: 1, seenUnitPriceTwd: 1000 }];

    expect(await checkout(alice, lines, -1)).toMatchObject({ ok: false, reason: "invalid_input" });
    expect(await checkout(alice, lines, 1.5)).toMatchObject({ ok: false, reason: "invalid_input" });
  });
});

describe("費率與配送類型的調整不改舊單", () => {
  it("調整費率後新單用新費率，舊單的運費、總額與明細類型不變", async () => {
    const jwt = await mintAccessJwt();
    const alice = await signInCustomer("alice");
    const small = await lamp();
    const big = await table();
    const first = await checkout(alice, [
      { variantId: small.variantId, quantity: 1, seenUnitPriceTwd: 1000 },
      { variantId: big.variantId, quantity: 1, seenUnitPriceTwd: 6000 },
    ], 700);
    if (!first.ok) throw new Error("下單失敗");

    expect(await app.setShippingRate(jwt, { deliveryType: "standard", feeTwd: 150 })).toEqual({ ok: true, data: { standard: 150, large: 600 } });
    expect(await app.setShippingRate(jwt, { deliveryType: "large", feeTwd: 0 })).toEqual({ ok: true, data: { standard: 150, large: 0 } });
    await app.updateVariant(jwt, { variantId: big.variantId, optionValues: [], priceTwd: 6000, deliveryType: "standard" });

    expect(await orderOf(alice, first.data.orderId)).toMatchObject({
      totalTwd: 7700,
      shippingFees: { standard: 100, large: 600 },
      lines: [{ deliveryType: "standard" }, { deliveryType: "large" }],
    });
    // 新單：大型變體已改一般宅配，與燈具同屬一般宅配，只收一次新的一般費率 150
    const second = await checkout(alice, [
      { variantId: small.variantId, quantity: 1, seenUnitPriceTwd: 1000 },
      { variantId: big.variantId, quantity: 1, seenUnitPriceTwd: 6000 },
    ], 150);
    expect(second).toMatchObject({ ok: true, data: { totalTwd: 7150 } });
    if (!second.ok) return;
    expect(await orderOf(alice, second.data.orderId)).toMatchObject({ shippingFees: { standard: 150, large: 0 }, lines: [{ deliveryType: "standard" }, { deliveryType: "standard" }] });
  });

  it("費率調為 0 即免運：運費合計 0 是合法的確認值", async () => {
    const jwt = await mintAccessJwt();
    const alice = await signInCustomer("alice");
    const small = await lamp();
    await app.setShippingRate(jwt, { deliveryType: "standard", feeTwd: 0 });

    expect(await checkout(alice, [{ variantId: small.variantId, quantity: 1, seenUnitPriceTwd: 1000 }], 0)).toMatchObject({ ok: true, data: { totalTwd: 1000 } });
  });
});

describe("下單、金流與通知金額一致", () => {
  it("訂單總額、信件與金流的金額都含運費且相同", async () => {
    const alice = await signInCustomer("alice");
    const small = await lamp();
    const big = await table();
    const gateway = installFakeGateway();
    const placed = await checkout(alice, [
      { variantId: small.variantId, quantity: 1, seenUnitPriceTwd: 1000 },
      { variantId: big.variantId, quantity: 1, seenUnitPriceTwd: 6000 },
    ], 700);
    if (!placed.ok) throw new Error("下單失敗");
    const { orderId, totalTwd } = placed.data;

    await startPaymentFor(alice, orderId, gateway);

    expect(gateway.created.map((payment) => payment.amountTwd)).toEqual([totalTwd]);
    expect((await orderOf(alice, orderId)).payments.map((payment) => payment.amountTwd)).toEqual([totalTwd]);
    const mail = await app.listMyMail(alice);
    if (!mail.ok) throw new Error("讀信失敗");
    const opened = await app.getMyMail(alice, { messageId: mail.data.find((message) => message.kind === "order_placed")!.id });
    expect(opened).toMatchObject({ ok: true, data: { body: expect.stringContaining(`應付 NT$${totalTwd}。`) } });
    expect(totalTwd).toBe(7700);
  });

  it("同一個冪等鍵重送不重複收運費、不產生第二張訂單或信件", async () => {
    const alice = await signInCustomer("alice");
    const big = await table();
    const key = newKey();
    const lines = [{ variantId: big.variantId, quantity: 1, seenUnitPriceTwd: 6000 }];

    const first = await checkout(alice, lines, 600, key);
    const again = await checkout(alice, lines, 600, key);

    expect(again).toEqual(first);
    const orders = await app.listMyOrders(alice);
    expect(orders.ok && orders.data).toHaveLength(1);
    const { results } = await env.DB.prepare("SELECT total_twd FROM orders").all<{ total_twd: number }>();
    expect(results).toEqual([{ total_twd: 6600 }]);
  });

  it("運費變動後同冪等鍵重送：回傳原訂單，不產生第二張", async () => {
    const alice = await signInCustomer("alice");
    const big = await table();
    const key = newKey();
    const lines = [{ variantId: big.variantId, quantity: 1, seenUnitPriceTwd: 6000 }];
    const first = await checkout(alice, lines, 600, key);
    await app.setShippingRate(await mintAccessJwt(), { deliveryType: "large", feeTwd: 900 });

    expect(await checkout(alice, lines, 900, key)).toEqual(first);
    const { results } = await env.DB.prepare("SELECT total_twd, large_shipping_fee_twd FROM orders").all();
    expect(results).toEqual([{ total_twd: 6600, large_shipping_fee_twd: 600 }]);
  });
});

describe("試算運費與管理", () => {
  it("費率列缺少時不靜默免運：讀取費率拋錯、含該類型的結帳整批失敗且不留訂單", async () => {
    const alice = await signInCustomer("alice");
    const big = await table();
    await env.DB.prepare("DELETE FROM shipping_rates WHERE delivery_type = 'large'").run();
    try {
      await expect(app.getShippingRates(await mintAccessJwt())).rejects.toThrow();
      await expect(checkout(alice, [{ variantId: big.variantId, quantity: 1, seenUnitPriceTwd: 6000 }], 0)).rejects.toThrow();
      expect((await env.DB.prepare("SELECT count(*) AS n FROM orders").first<{ n: number }>())!.n).toBe(0);
    } finally {
      await env.DB.prepare("INSERT INTO shipping_rates (delivery_type, fee_twd) VALUES ('large', 600)").run();
    }
  });

  it("getShippingQuote 不含下架商品與停賣的變體", async () => {
    const jwt = await mintAccessJwt();
    const small = await lamp();
    const big = await table();
    await app.unlistProduct(jwt, { id: small.productId });
    await app.setVariantDiscontinued(jwt, { variantId: big.variantId, discontinued: true });

    expect(await app.getShippingQuote({ variantIds: [small.variantId, big.variantId] })).toMatchObject({ ok: true, data: { variants: [] } });
  });

  it("getShippingQuote 回現行費率與各變體的配送類型，不存在的變體不出現，不需登入", async () => {
    const small = await lamp();
    const big = await table();

    expect(await app.getShippingQuote({ variantIds: [small.variantId, big.variantId, 999_999] })).toEqual({
      ok: true,
      data: { rates: { standard: 100, large: 600 }, variants: expect.arrayContaining([
        { variantId: small.variantId, deliveryType: "standard" },
        { variantId: big.variantId, deliveryType: "large" },
      ]) },
    });
    expect(await app.getShippingQuote({ variantIds: [0] })).toMatchObject({ ok: false, reason: "invalid_input" });
    expect(await app.getShippingQuote({})).toMatchObject({ ok: false, reason: "invalid_input" });
  });

  it("費率管理只有管理員：沒有有效 JWT 回 unauthorized，輸入不合法回 invalid_input", async () => {
    expect(await app.getShippingRates("not-a-jwt")).toEqual({ ok: false, reason: "unauthorized" });
    expect(await app.setShippingRate("not-a-jwt", { deliveryType: "standard", feeTwd: 1 })).toEqual({ ok: false, reason: "unauthorized" });
    const jwt = await mintAccessJwt();
    expect(await app.getShippingRates(jwt)).toEqual({ ok: true, data: { standard: 100, large: 600 } });
    expect(await app.setShippingRate(jwt, { deliveryType: "express", feeTwd: 1 })).toMatchObject({ ok: false, reason: "invalid_input" });
    expect(await app.setShippingRate(jwt, { deliveryType: "standard", feeTwd: -1 })).toMatchObject({ ok: false, reason: "invalid_input" });
    expect(await app.setShippingRate(jwt, { deliveryType: "standard", feeTwd: 1.5 })).toMatchObject({ ok: false, reason: "invalid_input" });
  });

  it("管理員設定變體配送類型：新增商品、新增變體與修改變體；不帶表示不動，無效值被拒", async () => {
    const jwt = await mintAccessJwt();
    const big = await table();
    const found = await app.getProductForAdmin(jwt, { id: big.productId });
    expect(found).toMatchObject({ ok: true, data: { variants: [{ id: big.variantId, deliveryType: "large" }] } });

    await app.updateVariant(jwt, { variantId: big.variantId, optionValues: [], priceTwd: 6100 });
    expect(await app.getProductForAdmin(jwt, { id: big.productId })).toMatchObject({ data: { variants: [{ deliveryType: "large", priceTwd: 6100 }] } });
    expect(await app.updateVariant(jwt, { variantId: big.variantId, optionValues: [], priceTwd: 6100, deliveryType: "express" })).toMatchObject({ ok: false, reason: "invalid_input" });

    // 沒有選項的商品，預設變體的配送類型走 updateProduct
    expect(await app.updateProduct(jwt, { id: big.productId, name: "餐桌", description: "", priceTwd: 6100, deliveryType: "standard" })).toMatchObject({ ok: true });
    expect(await app.getProductForAdmin(jwt, { id: big.productId })).toMatchObject({ data: { variants: [{ deliveryType: "standard" }] } });
    expect(await app.updateProduct(jwt, { id: big.productId, name: "餐桌", description: "", priceTwd: 6100 })).toMatchObject({ ok: true });
    expect(await app.getProductForAdmin(jwt, { id: big.productId })).toMatchObject({ data: { variants: [{ deliveryType: "standard" }] } });
    await app.updateVariant(jwt, { variantId: big.variantId, optionValues: [], priceTwd: 6100, deliveryType: "large" });
    await app.setProductOptions(jwt, { id: big.productId, optionNames: ["尺寸"], defaultVariantValues: ["180"] });
    const added = await app.createVariant(jwt, { productId: big.productId, optionValues: ["220"], priceTwd: 8000, deliveryType: "standard" });
    const plain = await app.createVariant(jwt, { productId: big.productId, optionValues: ["260"], priceTwd: 9000 });
    expect(added.ok && plain.ok).toBe(true);
    const variants = await app.getProductForAdmin(jwt, { id: big.productId });
    expect(variants.ok && variants.data.variants.map((variant) => variant.deliveryType)).toEqual(["large", "standard", "standard"]);
  });
});
