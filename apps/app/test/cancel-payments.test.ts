import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signInCustomer } from "./customers";
import { forceOrderStatus, resetDb } from "./db";
import { installFakeGateway } from "./fake-gateway";
import { orderOf, placeMugOrder, startPaymentFor, stockOf } from "./payment-helpers";
import { app } from "./release-helpers";

describe("取消訂單時進行中的付款一起失效", () => {
  beforeEach(resetDb);
  afterEach(() => vi.restoreAllMocks());

  it("有進行中的付款：先向閘道取消付款（本地轉已失效），再取消訂單，保留釋放", async () => {
    const alice = await signInCustomer("alice");
    const { orderId, variantId } = await placeMugOrder(alice, { onHand: 10, quantity: 2 });
    const gateway = installFakeGateway();
    const gatewayPaymentId = await startPaymentFor(alice, orderId, gateway);

    const result = await app.cancelOrder(alice, { orderId });

    expect(result).toEqual({ ok: true, data: { orderId, status: "cancelled" } });
    expect(gateway.cancelled).toEqual([gatewayPaymentId]);
    const order = await orderOf(alice, orderId);
    expect(order.status).toBe("cancelled");
    expect(order.payments).toMatchObject([{ status: "expired" }]);
    expect(await stockOf(variantId)).toEqual({ onHand: 10, available: 10 });
  });

  it("沒有進行中的付款：不呼叫閘道（閘道連不上也不影響取消）", async () => {
    const alice = await signInCustomer("alice");
    const { orderId } = await placeMugOrder(alice);
    const gateway = installFakeGateway();
    gateway.failNext("cancel", 0);

    expect(await app.cancelOrder(alice, { orderId })).toMatchObject({ ok: true });
    expect(gateway.cancelled).toEqual([]);
  });

  it("閘道取消回 409、查詢發現付款其實已成功：訂單轉為已付款，取消回 order_not_cancellable", async () => {
    const alice = await signInCustomer("alice");
    const { orderId, variantId } = await placeMugOrder(alice, { onHand: 10, quantity: 2 });
    const gateway = installFakeGateway();
    const gatewayPaymentId = await startPaymentFor(alice, orderId, gateway);
    gateway.settle(gatewayPaymentId, "succeeded"); // webhook 還沒送到，本地仍是 pending

    const result = await app.cancelOrder(alice, { orderId });

    expect(result).toEqual({ ok: false, reason: "order_not_cancellable" });
    const order = await orderOf(alice, orderId);
    expect(order.status).toBe("paid");
    expect(order.payments).toMatchObject([{ status: "succeeded" }]);
    expect(await stockOf(variantId)).toEqual({ onHand: 8, available: 8 });
    expect(gateway.refunded).toEqual([]);
  });

  it("閘道取消回 409、查詢發現付款已失敗：本地轉失敗，繼續取消訂單", async () => {
    const alice = await signInCustomer("alice");
    const { orderId } = await placeMugOrder(alice);
    const gateway = installFakeGateway();
    gateway.settle(await startPaymentFor(alice, orderId, gateway), "failed");

    expect(await app.cancelOrder(alice, { orderId })).toMatchObject({ ok: true });

    const order = await orderOf(alice, orderId);
    expect(order.status).toBe("cancelled");
    expect(order.payments).toMatchObject([{ status: "failed" }]);
  });

  it("閘道取消回 409、查詢時付款仍在進行中：payment_in_progress，訂單維持待付款", async () => {
    const alice = await signInCustomer("alice");
    const { orderId } = await placeMugOrder(alice);
    const gateway = installFakeGateway();
    const gatewayPaymentId = await startPaymentFor(alice, orderId, gateway);
    gateway.uncancellable.add(gatewayPaymentId);

    expect(await app.cancelOrder(alice, { orderId })).toEqual({ ok: false, reason: "payment_in_progress" });

    const order = await orderOf(alice, orderId);
    expect(order.status).toBe("pending_payment");
    expect(order.payments).toMatchObject([{ status: "pending" }]);
  });

  it.each([
    ["取消時閘道連不上", "cancel"],
    ["回 409 後查詢時閘道連不上", "get"],
  ] as const)("%s：payment_gateway_unavailable，訂單維持待付款、保留不釋放", async (_label, operation) => {
    const alice = await signInCustomer("alice");
    const { orderId, variantId } = await placeMugOrder(alice, { onHand: 10, quantity: 2 });
    const gateway = installFakeGateway();
    const gatewayPaymentId = await startPaymentFor(alice, orderId, gateway);
    if (operation === "get") gateway.uncancellable.add(gatewayPaymentId);
    gateway.failNext(operation, 0);

    expect(await app.cancelOrder(alice, { orderId })).toEqual({ ok: false, reason: "payment_gateway_unavailable" });

    const order = await orderOf(alice, orderId);
    expect(order.status).toBe("pending_payment");
    expect(order.payments).toMatchObject([{ status: "pending" }]);
    expect(await stockOf(variantId)).toEqual({ onHand: 10, available: 8 });
  });

  it("別人的訂單：order_not_found，不會動到它的付款", async () => {
    const alice = await signInCustomer("alice");
    const bob = await signInCustomer("bob");
    const { orderId } = await placeMugOrder(alice);
    const gateway = installFakeGateway();
    await startPaymentFor(alice, orderId, gateway);

    expect(await app.cancelOrder(bob, { orderId })).toEqual({ ok: false, reason: "order_not_found" });

    expect(gateway.cancelled).toEqual([]);
    expect((await orderOf(alice, orderId)).payments).toMatchObject([{ status: "pending" }]);
  });

  it("訂單已不是待付款（例如已逾期）：order_not_cancellable，不呼叫閘道", async () => {
    const alice = await signInCustomer("alice");
    const { orderId } = await placeMugOrder(alice);
    const gateway = installFakeGateway();
    await startPaymentFor(alice, orderId, gateway);
    await forceOrderStatus(orderId, "expired");

    expect(await app.cancelOrder(alice, { orderId })).toEqual({ ok: false, reason: "order_not_cancellable" });

    expect(gateway.cancelled).toEqual([]);
  });
});
