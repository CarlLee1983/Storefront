import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signInCustomer } from "./customers";
import { resetDb } from "./db";
import { installFakeGateway, type FakeGateway } from "./fake-gateway";
import { orderOf, placeMugOrder, stockOf } from "./payment-helpers";
import { createPaymentService } from "../src/payments/service";

const app = exports.default;

async function startPayment(cookie: string, orderId: number, gateway: FakeGateway): Promise<string> {
  const started = await app.startPayment(cookie, { orderId });
  if (!started.ok) throw new Error(`發起付款失敗：${started.reason}`);
  return gateway.lastPaymentId();
}

describe("confirmPayment：導回時主動向閘道查詢", () => {
  beforeEach(resetDb);
  afterEach(() => vi.restoreAllMocks());

  it("閘道說付款成功（webhook 還沒到）：套用結果，訂單轉為已付款、在庫數扣除", async () => {
    const alice = await signInCustomer("alice");
    const { orderId, variantId } = await placeMugOrder(alice, { onHand: 10, quantity: 2 });
    const gateway = installFakeGateway();
    const gatewayPaymentId = await startPayment(alice, orderId, gateway);
    gateway.settle(gatewayPaymentId, "succeeded");

    const result = await app.confirmPayment(alice, { orderId, gatewayPaymentId });

    expect(result).toEqual({ ok: true, data: { paymentStatus: "succeeded", orderStatus: "paid" } });
    expect((await orderOf(alice, orderId)).status).toBe("paid");
    expect(await stockOf(variantId)).toEqual({ onHand: 8, available: 8 });
  });

  it("閘道說付款失敗：付款記為失敗，訂單仍是待付款", async () => {
    const alice = await signInCustomer("alice");
    const { orderId } = await placeMugOrder(alice);
    const gateway = installFakeGateway();
    const gatewayPaymentId = await startPayment(alice, orderId, gateway);
    gateway.settle(gatewayPaymentId, "failed");

    expect(await app.confirmPayment(alice, { orderId, gatewayPaymentId })).toEqual({
      ok: true,
      data: { paymentStatus: "failed", orderStatus: "pending_payment" },
    });
  });

  it("閘道說付款已失效（expired）：本地付款轉為 expired，不再停在 pending；訂單與在庫數不動", async () => {
    const alice = await signInCustomer("alice");
    const { orderId, variantId } = await placeMugOrder(alice, { onHand: 10, quantity: 2 });
    const gateway = installFakeGateway();
    const gatewayPaymentId = await startPayment(alice, orderId, gateway);
    gateway.payments.get(gatewayPaymentId)!.status = "expired";

    const result = await app.confirmPayment(alice, { orderId, gatewayPaymentId });

    expect(result).toEqual({ ok: true, data: { paymentStatus: "expired", orderStatus: "pending_payment" } });
    expect((await orderOf(alice, orderId)).payments).toMatchObject([{ status: "expired" }]);
    expect(await stockOf(variantId)).toEqual({ onHand: 10, available: 8 });
  });

  it.each([
    ["金額不符", { amountTwd: 1 }],
    ["merchantReference 不是這張訂單", { merchantReference: "999999" }],
  ])("閘道回的%s：payment_mismatch，不套用、記一行 payment_gateway_mismatch", async (_label, tampered) => {
    const alice = await signInCustomer("alice");
    const { orderId } = await placeMugOrder(alice);
    const gateway = installFakeGateway();
    const gatewayPaymentId = await startPayment(alice, orderId, gateway);
    gateway.settle(gatewayPaymentId, "succeeded");
    Object.assign(gateway.payments.get(gatewayPaymentId)!, tampered);
    const errors = vi.spyOn(console, "error");

    expect(await app.confirmPayment(alice, { orderId, gatewayPaymentId })).toEqual({ ok: false, reason: "payment_mismatch" });

    expect((await orderOf(alice, orderId)).status).toBe("pending_payment");
    expect(errors.mock.calls.some(([line]) => String(line).includes('"event":"payment_gateway_mismatch"'))).toBe(true);
  });

  it.each([
    ["pending（顧客還沒付完）", "pending"],
  ] as const)("閘道仍是 %s：不套用，回目前狀態，訂單與在庫數不動", async (_label, status) => {
    const alice = await signInCustomer("alice");
    const { orderId, variantId } = await placeMugOrder(alice, { onHand: 10, quantity: 2 });
    const gateway = installFakeGateway();
    const gatewayPaymentId = await startPayment(alice, orderId, gateway);
    gateway.payments.get(gatewayPaymentId)!.status = status;

    expect(await app.confirmPayment(alice, { orderId, gatewayPaymentId })).toEqual({
      ok: true,
      data: { paymentStatus: "pending", orderStatus: "pending_payment" },
    });
    expect(await stockOf(variantId)).toEqual({ onHand: 10, available: 8 });
  });

  it("閘道說成功卻沒有事件 ID：無法冪等，不套用", async () => {
    const alice = await signInCustomer("alice");
    const { orderId } = await placeMugOrder(alice);
    const gateway = installFakeGateway();
    const gatewayPaymentId = await startPayment(alice, orderId, gateway);
    gateway.payments.get(gatewayPaymentId)!.status = "succeeded";

    expect(await app.confirmPayment(alice, { orderId, gatewayPaymentId })).toMatchObject({
      ok: true,
      data: { paymentStatus: "pending", orderStatus: "pending_payment" },
    });
  });

  it("webhook 已先套用：導回查詢與它共用事件 ID，回同一結果，在庫數只扣一次", async () => {
    const alice = await signInCustomer("alice");
    const { orderId, variantId } = await placeMugOrder(alice, { onHand: 10, quantity: 2 });
    const gateway = installFakeGateway();
    const gatewayPaymentId = await startPayment(alice, orderId, gateway);
    const webhook = await app.applyPaymentResult(gateway.settle(gatewayPaymentId, "succeeded"));

    const confirmed = await app.confirmPayment(alice, { orderId, gatewayPaymentId });

    expect(confirmed).toEqual(webhook);
    expect(await stockOf(variantId)).toEqual({ onHand: 8, available: 8 });
  });

  it("webhook 與導回同時送達（Promise.all）：結果一致，在庫數只扣一次", async () => {
    const alice = await signInCustomer("alice");
    const { orderId, variantId } = await placeMugOrder(alice, { onHand: 10, quantity: 2 });
    const gateway = installFakeGateway();
    const gatewayPaymentId = await startPayment(alice, orderId, gateway);
    const event = gateway.settle(gatewayPaymentId, "succeeded");

    const [webhook, confirmed] = await Promise.all([
      app.applyPaymentResult(event),
      app.confirmPayment(alice, { orderId, gatewayPaymentId }),
    ]);

    expect(webhook).toEqual({ ok: true, data: { paymentStatus: "succeeded", orderStatus: "paid" } });
    expect(confirmed).toEqual(webhook);
    expect(await stockOf(variantId)).toEqual({ onHand: 8, available: 8 });
  });

  it("付款不屬於這張訂單（是同一位顧客另一張訂單的付款）：payment_not_found，不套用", async () => {
    const alice = await signInCustomer("alice");
    const first = await placeMugOrder(alice);
    const second = await placeMugOrder(alice);
    const gateway = installFakeGateway();
    const paymentOfSecond = await startPayment(alice, second.orderId, gateway);
    gateway.settle(paymentOfSecond, "succeeded");

    expect(await app.confirmPayment(alice, { orderId: first.orderId, gatewayPaymentId: paymentOfSecond })).toEqual({
      ok: false,
      reason: "payment_not_found",
    });
    expect((await orderOf(alice, second.orderId)).status).toBe("pending_payment");
  });

  it("別人的訂單與付款：order_not_found，不套用", async () => {
    const alice = await signInCustomer("alice");
    const bob = await signInCustomer("bob");
    const { orderId } = await placeMugOrder(alice);
    const gateway = installFakeGateway();
    const gatewayPaymentId = await startPayment(alice, orderId, gateway);
    gateway.settle(gatewayPaymentId, "succeeded");

    expect(await app.confirmPayment(bob, { orderId, gatewayPaymentId })).toEqual({ ok: false, reason: "order_not_found" });

    expect((await orderOf(alice, orderId)).status).toBe("pending_payment");
  });

  it("閘道付款 ID 不存在：payment_not_found", async () => {
    const alice = await signInCustomer("alice");
    const { orderId } = await placeMugOrder(alice);
    installFakeGateway();

    expect(await app.confirmPayment(alice, { orderId, gatewayPaymentId: "pay_missing" })).toEqual({ ok: false, reason: "payment_not_found" });
  });

  it.each([
    ["閘道回 502", 502],
    ["連不上閘道", 0],
  ])("%s：payment_gateway_unavailable，不套用", async (_label, status) => {
    const alice = await signInCustomer("alice");
    const { orderId } = await placeMugOrder(alice);
    const gateway = installFakeGateway();
    const gatewayPaymentId = await startPayment(alice, orderId, gateway);
    gateway.settle(gatewayPaymentId, "succeeded");
    gateway.failNext("get", status);

    expect(await app.confirmPayment(alice, { orderId, gatewayPaymentId })).toEqual({ ok: false, reason: "payment_gateway_unavailable" });

    expect((await orderOf(alice, orderId)).status).toBe("pending_payment");
  });

  it("沒有 session：unauthorized", async () => {
    expect(await app.confirmPayment("", { orderId: 1, gatewayPaymentId: "pay_1" })).toEqual({ ok: false, reason: "unauthorized" });
  });

  it.each([
    ["缺 gatewayPaymentId", { orderId: 1 }],
    ["orderId 不是整數", { orderId: 1.5, gatewayPaymentId: "pay_1" }],
    ["gatewayPaymentId 含奇怪字元", { orderId: 1, gatewayPaymentId: "../x" }],
  ])("輸入不合法（%s）：invalid_input", async (_label, input) => {
    const alice = await signInCustomer("alice");

    expect(await app.confirmPayment(alice, input)).toMatchObject({ ok: false, reason: "invalid_input" });
  });

  it("閘道尚未設定：payment_unavailable，fail closed", async () => {
    const service = createPaymentService({} as D1Database, { now: () => Date.now() }, async () => "someone", null, "http://localhost:4321");

    expect(await service.confirmPayment("cookie", { orderId: 1, gatewayPaymentId: "pay_1" })).toEqual({
      ok: false,
      reason: "payment_unavailable",
    });
  });
});
