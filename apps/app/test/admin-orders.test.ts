import { exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { mintAccessJwt } from "./access";
import { signInCustomer } from "./customers";
import { SHIPPING_INFO } from "./checkout-helpers";
import { forceOrderStatus, resetDb, seedPayment } from "./db";
import { placeMugOrder } from "./payment-helpers";

const app = exports.default;

describe("管理員訂單清單", () => {
  beforeEach(resetDb);

  it("列出所有顧客的訂單，新的在前，含顧客 email、總金額、狀態與成立時間", async () => {
    const alice = await signInCustomer("alice");
    const bob = await signInCustomer("bob");
    const first = await placeMugOrder(alice, { quantity: 2 });
    const second = await placeMugOrder(bob, { quantity: 1 });

    const result = await app.listOrdersForAdmin(await mintAccessJwt(), {});

    expect(result).toEqual({
      ok: true,
      data: [
        { id: second.orderId, status: "pending_payment", totalTwd: 320, customerEmail: "bob@example.com", createdAt: expect.any(Number) },
        { id: first.orderId, status: "pending_payment", totalTwd: 640, customerEmail: "alice@example.com", createdAt: expect.any(Number) },
      ],
    });
  });

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

  it("含訂單明細快照、收件資訊、顧客 email、所有付款嘗試，尚未出貨時物流單號與出貨時間為 null", async () => {
    const alice = await signInCustomer("alice");
    const { orderId, productId } = await placeMugOrder(alice, { quantity: 2 });
    await seedPayment(orderId, "failed", "seed_failed");
    await seedPayment(orderId, "succeeded", "seed_ok");

    const result = await app.getOrderForAdmin(await mintAccessJwt(), { orderId });

    expect(result).toEqual({
      ok: true,
      data: {
        id: orderId,
        status: "pending_payment",
        totalTwd: 640,
        customerEmail: "alice@example.com",
        shippingInfo: SHIPPING_INFO,
        paymentDeadline: expect.any(Number),
        createdAt: expect.any(Number),
        lines: [{ productId, productName: "馬克杯", quantity: 2, unitPriceTwd: 320 }],
        payments: [
          { id: expect.any(Number), amountTwd: 1, status: "failed", createdAt: 0 },
          { id: expect.any(Number), amountTwd: 1, status: "succeeded", createdAt: 0 },
        ],
        trackingNumber: null,
        shippedAt: null,
      },
    });
  });

  it("訂單不存在回 order_not_found；訂單編號無效回 invalid_input", async () => {
    const jwt = await mintAccessJwt();

    expect(await app.getOrderForAdmin(jwt, { orderId: 999 })).toEqual({ ok: false, reason: "order_not_found" });
    expect(await app.getOrderForAdmin(jwt, { orderId: "abc" })).toMatchObject({ ok: false, reason: "invalid_input" });
  });
});
