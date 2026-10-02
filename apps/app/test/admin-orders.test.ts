import { exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { mintAccessJwt } from "./access";
import { signInCustomer } from "./customers";
import { checkoutInput, createStockedListing, SHIPPING_INFO } from "./checkout-helpers";
import { forceOrderStatus, resetDb, seedPayment } from "./db";
import { placeMugOrder } from "./payment-helpers";

const app = exports.default;

describe("管理員訂單清單", () => {
  beforeEach(resetDb);

  it("沒有任何訂單時回空清單", async () => {
    expect(await app.listOrdersForAdmin(await mintAccessJwt(), {})).toEqual({ ok: true, data: [] });
  });

  it("列出所有顧客的訂單，新的在前，含顧客 email、總金額、狀態與成立時間", async () => {
    const alice = await signInCustomer("alice");
    const bob = await signInCustomer("bob");
    const first = await placeMugOrder(alice, { quantity: 2 });
    const second = await placeMugOrder(bob, { quantity: 1 });

    const result = await app.listOrdersForAdmin(await mintAccessJwt(), {});

    expect(result).toEqual({
      ok: true,
      data: [
        { id: second.orderId, status: "pending_payment", totalTwd: 420, customerEmail: "bob@example.com", createdAt: expect.any(Number), needsAttention: false, lines: [expect.objectContaining({ cover: expect.objectContaining({ id: expect.any(String) }) })] },
        { id: first.orderId, status: "pending_payment", totalTwd: 740, customerEmail: "alice@example.com", createdAt: expect.any(Number), needsAttention: false, lines: [expect.objectContaining({ cover: expect.objectContaining({ id: expect.any(String) }) })] },
      ],
    });
  });

  it("最新 200 筆都有明細與封面，超過 100 張仍可讀取且較舊訂單不混入", async () => {
    const cookie = await signInCustomer("alice");
    const { productId, variantId } = await createStockedListing("大量訂單商品", 100, 201);
    const ids: number[] = [];
    for (let index = 0; index < 201; index++) {
      const placed = await app.checkout(cookie, checkoutInput([{ variantId, quantity: 1, seenUnitPriceTwd: 100 }]));
      if (!placed.ok) throw new Error(`結帳失敗：${placed.reason}`);
      ids.push(placed.data.orderId);
    }
    const result = await app.listOrdersForAdmin(await mintAccessJwt(), {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.map(order => order.id)).toEqual(ids.slice(1).reverse());
    for (const order of result.data) {
      expect(order.lines).toEqual([{ id: expect.any(Number), productId, variantId, productName: "大量訂單商品", variantLabel: "", quantity: 1, unitPriceTwd: 100, deliveryType: "standard", shippedQuantity: 0,
        cover: expect.objectContaining({ id: expect.any(String), variants: expect.any(Array) }) }]);
    }
  }, 30_000);

  it("依訂單狀態篩選；狀態值無效回 invalid_input", async () => {
    const alice = await signInCustomer("alice");
    const pending = await placeMugOrder(alice);
    const paid = await placeMugOrder(alice);
    await forceOrderStatus(paid.orderId, "paid");
    const jwt = await mintAccessJwt();

    const onlyPaid = await app.listOrdersForAdmin(jwt, { status: "paid" });
    const onlyPending = await app.listOrdersForAdmin(jwt, { status: "pending_payment" });
    const noneShipped = await app.listOrdersForAdmin(jwt, { status: "shipped" });

    expect(onlyPaid.ok && onlyPaid.data.map((order) => order.id)).toEqual([paid.orderId]);
    expect(onlyPending.ok && onlyPending.data.map((order) => order.id)).toEqual([pending.orderId]);
    expect(noneShipped).toEqual({ ok: true, data: [] });
    expect(await app.listOrdersForAdmin(jwt, { status: "mystery" })).toMatchObject({ ok: false, reason: "invalid_input" });
  });
});

describe("管理員訂單明細", () => {
  beforeEach(resetDb);

  it("含訂單明細快照、收件資訊、顧客 email、所有付款嘗試，尚未出貨時沒有出貨批次", async () => {
    const alice = await signInCustomer("alice");
    const { orderId, productId, variantId } = await placeMugOrder(alice, { quantity: 2 });
    await seedPayment(orderId, "failed", "seed_failed");
    await seedPayment(orderId, "succeeded", "seed_ok");

    const result = await app.getOrderForAdmin(await mintAccessJwt(), { orderId });

    expect(result).toEqual({
      ok: true,
      data: {
        id: orderId,
        status: "pending_payment",
        totalTwd: 740,
        shippingFees: { standard: 100, large: 0 },
        customerEmail: "alice@example.com",
        shippingInfo: SHIPPING_INFO,
        paymentDeadline: expect.any(Number),
        createdAt: expect.any(Number),
        lines: [{ id: expect.any(Number), productId, variantId, productName: "馬克杯", variantLabel: "", quantity: 2, unitPriceTwd: 320, deliveryType: "standard", shippedQuantity: 0, cover: expect.objectContaining({ id: expect.any(String), variants: expect.any(Array) }) }],
        payments: [
          { id: expect.any(Number), amountTwd: 1, status: "failed", createdAt: 0, refundReason: null, refundAt: null, needsAttention: false },
          // 待付款的訂單上有成功的付款：不是由它支付的，也沒有退款紀錄
          { id: expect.any(Number), amountTwd: 1, status: "succeeded", createdAt: 0, refundReason: null, refundAt: null, needsAttention: true },
        ],
        shipments: [],
      },
    });
  });

  it("訂單不存在回 order_not_found；訂單編號無效回 invalid_input", async () => {
    const jwt = await mintAccessJwt();

    expect(await app.getOrderForAdmin(jwt, { orderId: 999 })).toEqual({ ok: false, reason: "order_not_found" });
    expect(await app.getOrderForAdmin(jwt, { orderId: "abc" })).toMatchObject({ ok: false, reason: "invalid_input" });
  });
});
