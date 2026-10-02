import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ADMIN_EMAIL, mintAccessJwt } from "./access";
import { createStockedListing } from "./checkout-helpers";
import { signInCustomer } from "./customers";
import { forceOrderStatus, resetDb } from "./db";
import { installFakeGateway } from "./fake-gateway";
import { orderOf, placeMugOrder, startPaymentFor, stockOf } from "./payment-helpers";

const app = exports.default;

async function movements(query: Record<string, unknown> = {}) {
  const result = await app.listStockMovements(await mintAccessJwt(), query);
  if (!result.ok) throw new Error(`讀取流水失敗：${result.reason}`);
  return result.data;
}

describe("付款保留、交運才扣庫（ADR 0006）", () => {
  beforeEach(resetDb);
  afterEach(() => vi.restoreAllMocks());

  it("付款成功只把待付款保留轉為已付款保留：在庫數與可售數量都不變，也不寫流水", async () => {
    const alice = await signInCustomer("alice");
    const { orderId, variantId } = await placeMugOrder(alice, { onHand: 10, quantity: 2 });
    const gateway = installFakeGateway();
    const gatewayPaymentId = await startPaymentFor(alice, orderId, gateway);
    expect(await stockOf(variantId)).toEqual({ onHand: 10, available: 8 });

    await app.applyPaymentResult(gateway.settle(gatewayPaymentId, "succeeded"));

    expect((await orderOf(alice, orderId)).status).toBe("paid");
    expect(await stockOf(variantId)).toEqual({ onHand: 10, available: 8 });
    expect((await movements()).items.map((item) => item.kind)).toEqual(["adjustment"]);
  });

  it("交運扣實體在庫、消耗已付款保留：可售數量不變，流水記下訂單、操作人與時間", async () => {
    const alice = await signInCustomer("alice");
    const { orderId, variantId } = await placeMugOrder(alice, { onHand: 10, quantity: 2 });
    await forceOrderStatus(orderId, "paid");

    const shipped = await app.shipOrder(await mintAccessJwt(), { orderId });

    expect(shipped).toMatchObject({ ok: true });
    expect(await stockOf(variantId)).toEqual({ onHand: 8, available: 8 });
    const [dispatch] = (await movements({ variantId })).items;
    expect(dispatch).toMatchObject({ kind: "dispatch", variantId, delta: -2, onHandAfter: 8, orderId, actor: ADMIN_EMAIL, createdAt: expect.any(Number) });
    expect(dispatch!.reason).not.toBe("");
  });

  it("重複出貨與不是已付款的訂單都不再扣庫、不寫流水", async () => {
    const alice = await signInCustomer("alice");
    const { orderId, variantId } = await placeMugOrder(alice, { onHand: 10, quantity: 2 });
    const jwt = await mintAccessJwt();
    expect(await app.shipOrder(jwt, { orderId })).toEqual({ ok: false, reason: "order_not_shippable" });
    await forceOrderStatus(orderId, "paid");
    await app.shipOrder(jwt, { orderId });

    expect(await app.shipOrder(jwt, { orderId })).toEqual({ ok: false, reason: "order_not_shippable" });

    expect(await stockOf(variantId)).toEqual({ onHand: 8, available: 8 });
    expect((await movements({ variantId })).items.filter((item) => item.kind === "dispatch")).toHaveLength(1);
  });

  it("同時出貨同一張訂單：只有一次成功，只扣一次庫、只寫一筆流水", async () => {
    const alice = await signInCustomer("alice");
    const { orderId, variantId } = await placeMugOrder(alice, { onHand: 10, quantity: 2 });
    await forceOrderStatus(orderId, "paid");
    const jwt = await mintAccessJwt();

    const results = await Promise.all([app.shipOrder(jwt, { orderId }), app.shipOrder(jwt, { orderId }), app.shipOrder(jwt, { orderId })]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(await stockOf(variantId)).toEqual({ onHand: 8, available: 8 });
    expect((await movements({ variantId })).items.filter((item) => item.kind === "dispatch")).toHaveLength(1);
  });

  it("已付款保留會擋住庫存調整與新訂單：調整後可售不可為負", async () => {
    const alice = await signInCustomer("alice");
    const { orderId, variantId } = await placeMugOrder(alice, { onHand: 10, quantity: 2 });
    await forceOrderStatus(orderId, "paid");
    const jwt = await mintAccessJwt();

    expect(await app.adjustStock(jwt, { variantId, delta: -9, reason: "盤損" })).toEqual({ ok: false, reason: "insufficient_stock" });
    expect(await app.adjustStock(jwt, { variantId, delta: -8, reason: "盤損" })).toEqual({ ok: true, data: { onHand: 2, available: 0 } });
  });

  it("多變體訂單交運時每個變體各扣自己的數量，各寫一筆流水", async () => {
    const alice = await signInCustomer("alice");
    const { orderId, variantId: mug } = await placeMugOrder(alice, { onHand: 5, quantity: 3 });
    const plate = (await createStockedListing("盤子", 200, 4)).variantId;
    const order = await app.checkout(alice, {
      lines: [{ variantId: mug, quantity: 1, seenUnitPriceTwd: 320 }, { variantId: plate, quantity: 2, seenUnitPriceTwd: 200 }],
      shippingInfo: { name: "王小明", phone: "0912345678", address: "台北市中正區重慶南路一段 122 號" },
      seenShippingTwd: 100,
      idempotencyKey: "ledger-multi-line-0001",
    });
    if (!order.ok) throw new Error(order.reason);
    await forceOrderStatus(order.data.orderId, "paid");
    await forceOrderStatus(orderId, "cancelled");

    await app.shipOrder(await mintAccessJwt(), { orderId: order.data.orderId });

    expect(await stockOf(mug)).toEqual({ onHand: 4, available: 4 });
    expect(await stockOf(plate)).toEqual({ onHand: 2, available: 2 });
    const dispatches = (await movements()).items.filter((item) => item.kind === "dispatch");
    expect(dispatches.map(({ variantId, delta }) => ({ variantId, delta })).sort((a, b) => a.variantId - b.variantId)).toEqual(
      [{ variantId: mug, delta: -1 }, { variantId: plate, delta: -2 }].sort((a, b) => a.variantId - b.variantId),
    );
  });

  it("待付款逾期與取消釋放保留；已付款保留不受影響", async () => {
    const alice = await signInCustomer("alice");
    const { orderId: paidId, variantId } = await placeMugOrder(alice, { onHand: 10, quantity: 2 });
    await forceOrderStatus(paidId, "paid");
    const pending = await app.checkout(alice, {
      lines: [{ variantId, quantity: 3, seenUnitPriceTwd: 320 }],
      shippingInfo: { name: "王小明", phone: "0912345678", address: "台北市中正區重慶南路一段 122 號" },
      seenShippingTwd: 100,
      idempotencyKey: "ledger-pending-0001",
    });
    if (!pending.ok) throw new Error(pending.reason);
    expect(await stockOf(variantId)).toEqual({ onHand: 10, available: 5 });

    await app.cancelOrder(alice, { orderId: pending.data.orderId });

    expect(await stockOf(variantId)).toEqual({ onHand: 10, available: 8 });
  });
});

describe("庫存流水", () => {
  beforeEach(resetDb);

  it("調整寫入流水：變動量、調整後在庫數、操作人、原因與時間，新的在前", async () => {
    const { variantId } = await createStockedListing("馬克杯", 320, 0);
    const jwt = await mintAccessJwt();

    await app.adjustStock(jwt, { variantId, delta: 20, reason: "  進貨  " });
    await app.adjustStock(jwt, { variantId, delta: -3, reason: "盤損" });

    const { items } = await movements({ variantId });
    expect(items).toMatchObject([
      { kind: "adjustment", delta: -3, onHandAfter: 17, orderId: null, actor: ADMIN_EMAIL, reason: "盤損", productName: "馬克杯" },
      { kind: "adjustment", delta: 20, onHandAfter: 20, reason: "進貨" },
    ]);
    expect(items[0]!.createdAt).toBeGreaterThanOrEqual(items[1]!.createdAt);
  });

  it("被拒絕的調整不寫流水", async () => {
    const { variantId } = await createStockedListing("馬克杯", 320, 2);

    expect(await app.adjustStock(await mintAccessJwt(), { variantId, delta: -3, reason: "盤損" })).toEqual({ ok: false, reason: "insufficient_stock" });
    expect(await app.adjustStock(await mintAccessJwt(), { variantId: 999999, delta: 3, reason: "補貨" })).toEqual({ ok: false, reason: "variant_not_found" });

    expect((await movements({ variantId })).items).toHaveLength(1);
  });

  it.each([undefined, "", "   ", "x".repeat(201)])("調整的原因必填且不超過 200 字（%j）", async (reason) => {
    const { variantId } = await createStockedListing("馬克杯", 320, 2);

    const result = await app.adjustStock(await mintAccessJwt(), { variantId, delta: 1, reason });

    expect(result).toMatchObject({ ok: false, reason: "invalid_input", fields: { reason: [expect.any(String)] } });
    expect(await stockOf(variantId)).toEqual({ onHand: 2, available: 2 });
  });

  it("可依變體篩選並以游標分頁", async () => {
    const a = (await createStockedListing("甲", 100, 0)).variantId;
    const b = (await createStockedListing("乙", 100, 0)).variantId;
    const jwt = await mintAccessJwt();
    for (let i = 1; i <= 3; i++) await app.adjustStock(jwt, { variantId: a, delta: i, reason: `第 ${i} 次` });
    await app.adjustStock(jwt, { variantId: b, delta: 1, reason: "乙" });

    const first = await movements({ variantId: a, limit: 2 });
    expect(first.items.map((item) => item.reason)).toEqual(["第 3 次", "第 2 次"]);
    expect(first.nextBeforeId).not.toBeNull();
    const second = await movements({ variantId: a, limit: 2, beforeId: first.nextBeforeId });
    expect(second.items.map((item) => item.reason)).toEqual(["第 1 次"]);
    expect(second.nextBeforeId).toBeNull();
    expect((await movements()).items).toHaveLength(4);
  });

  it("只有管理員讀得到流水", async () => {
    expect(await app.listStockMovements("not-a-jwt", {})).toEqual({ ok: false, reason: "unauthorized" });
    expect(await app.listStockMovements(await mintAccessJwt(), { limit: 0 })).toMatchObject({ ok: false, reason: "invalid_input" });
  });
});
