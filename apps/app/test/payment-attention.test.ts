import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mintAccessJwt } from "./access";
import { signInCustomer } from "./customers";
import { forceOrderStatus, forcePaymentStatus, resetDb, seedPayment } from "./db";
import { installFakeGateway } from "./fake-gateway";
import { orderOf, placeMugOrder, startPaymentFor, stockOf } from "./payment-helpers";

const app = exports.default;

/** 管理端看到的這張訂單的付款摘要（走 RPC）。 */
async function adminPayments(orderId: number) {
  const found = await app.getOrderForAdmin(await mintAccessJwt(), { orderId });
  if (!found.ok) throw new Error("讀取訂單失敗");
  return found.data.payments;
}

/** 管理端清單上這張訂單是否標了需要處理。 */
async function listedNeedsAttention(orderId: number): Promise<boolean | undefined> {
  const listed = await app.listOrdersForAdmin(await mintAccessJwt(), {});
  if (!listed.ok) throw new Error("讀取清單失敗");
  return listed.data.find((order) => order.id === orderId)?.needsAttention;
}

describe("付款成功但未處理：需要處理的旗標（由查詢推導）", () => {
  beforeEach(resetDb);
  afterEach(() => vi.restoreAllMocks());

  it("已取消的訂單上有成功、但沒有退款紀錄的付款（退款前程序中斷）：旗標為 true，清單也標記", async () => {
    const alice = await signInCustomer("alice");
    const { orderId } = await placeMugOrder(alice);
    await forceOrderStatus(orderId, "cancelled");
    await seedPayment(orderId, "succeeded");

    expect(await adminPayments(orderId)).toMatchObject([{ status: "succeeded", needsAttention: true, refundReason: null, refundAt: null }]);
    expect(await listedNeedsAttention(orderId)).toBe(true);
  });

  it("已逾期的訂單上有成功、沒有退款紀錄的付款：旗標為 true", async () => {
    const alice = await signInCustomer("alice");
    const { orderId } = await placeMugOrder(alice);
    await forceOrderStatus(orderId, "expired");
    await seedPayment(orderId, "succeeded");

    expect(await adminPayments(orderId)).toMatchObject([{ needsAttention: true }]);
  });

  it("正常已付款的訂單（付款成功讓它轉已付款）：旗標為 false，清單不標記；出貨後仍是 false", async () => {
    const alice = await signInCustomer("alice");
    const { orderId } = await placeMugOrder(alice);
    const gateway = installFakeGateway();
    const gatewayPaymentId = await startPaymentFor(alice, orderId, gateway);
    await app.applyPaymentResult(gateway.settle(gatewayPaymentId, "succeeded"));

    expect(await adminPayments(orderId)).toMatchObject([{ status: "succeeded", needsAttention: false }]);
    expect(await listedNeedsAttention(orderId)).toBe(false);

    await app.shipOrder(await mintAccessJwt(), { orderId });
    expect(await adminPayments(orderId)).toMatchObject([{ needsAttention: false }]);
  });

  it("已退款的付款：旗標為 false，且管理端看得到退款狀態、原因與時間", async () => {
    const alice = await signInCustomer("alice");
    const { orderId } = await placeMugOrder(alice);
    const gateway = installFakeGateway();
    const gatewayPaymentId = await startPaymentFor(alice, orderId, gateway);
    await forceOrderStatus(orderId, "cancelled");
    await app.applyPaymentResult(gateway.settle(gatewayPaymentId, "succeeded"));

    expect(await adminPayments(orderId)).toMatchObject([
      { status: "refunded", refundReason: "cancelled_order", refundAt: expect.any(Number), needsAttention: false },
    ]);
    expect(await listedNeedsAttention(orderId)).toBe(false);
  });

  it("退款失敗（refund_failed）：款項還沒退回，旗標為 true（明細與清單都標記），退款原因與時間仍照實顯示", async () => {
    const alice = await signInCustomer("alice");
    const { orderId } = await placeMugOrder(alice);
    const gateway = installFakeGateway();
    const gatewayPaymentId = await startPaymentFor(alice, orderId, gateway);
    await forceOrderStatus(orderId, "cancelled");
    gateway.failNext("refund", 502);
    await app.applyPaymentResult(gateway.settle(gatewayPaymentId, "succeeded"));

    expect(await adminPayments(orderId)).toMatchObject([
      { status: "refund_failed", refundReason: "cancelled_order", refundAt: expect.any(Number), needsAttention: true },
    ]);
    expect(await listedNeedsAttention(orderId)).toBe(true);
  });

  it("訂單已由另一筆成功付款支付：這一筆（第二筆）成功卻沒有退款紀錄 → true，讓訂單轉已付款的那筆 → false", async () => {
    const alice = await signInCustomer("alice");
    const { orderId } = await placeMugOrder(alice);
    const gateway = installFakeGateway();
    const first = await startPaymentFor(alice, orderId, gateway);
    await app.applyPaymentResult(gateway.settle(first, "succeeded"));
    await seedPayment(orderId, "succeeded", "seed_second");

    expect(await adminPayments(orderId)).toMatchObject([{ needsAttention: false }, { needsAttention: true }]);
    expect(await listedNeedsAttention(orderId)).toBe(true);
  });

  it("沒有成功的付款（pending、failed、expired）：旗標為 false", async () => {
    const alice = await signInCustomer("alice");
    const { orderId } = await placeMugOrder(alice);
    for (const status of ["pending", "failed", "expired"]) await seedPayment(orderId, status);

    expect((await adminPayments(orderId)).map((payment) => payment.needsAttention)).toEqual([false, false, false]);
    expect(await listedNeedsAttention(orderId)).toBe(false);
  });

  it("已逾期的訂單上有一筆舊的成功付款 B（沒有退款紀錄），遲到成功的 A 重新保留成功：在庫數扣除，旗標標在 B、不標 A（不論編號大小）", async () => {
    const alice = await signInCustomer("alice");
    const { orderId, variantId } = await placeMugOrder(alice, { onHand: 10, quantity: 2 });
    const gateway = installFakeGateway();
    // B 的編號比 A 小：安排成先有一筆（之後被改成「成功、沒退款」的）舊付款，再由真正的流程發起 A
    const older = await seedPayment(orderId, "expired", "older_success");
    const gatewayPaymentId = await startPaymentFor(alice, orderId, gateway);
    await forcePaymentStatus(older, "succeeded");
    await forceOrderStatus(orderId, "expired");

    await app.applyPaymentResult(gateway.settle(gatewayPaymentId, "succeeded"));

    expect(await stockOf(variantId)).toEqual({ onHand: 8, available: 8 });
    const payments = await adminPayments(orderId);
    expect(payments).toMatchObject([
      { status: "succeeded", needsAttention: true }, // B：訂單不是由它支付
      { status: "succeeded", needsAttention: false }, // A：讓訂單轉已付款的那一筆
    ]);
    expect((await orderOf(alice, orderId)).status).toBe("paid");
  });

  it("已出貨的訂單收到重複的成功付款：在庫數不動，退款（duplicate_success），訂單維持已出貨", async () => {
    const alice = await signInCustomer("alice");
    const { orderId, variantId, totalTwd } = await placeMugOrder(alice, { onHand: 10, quantity: 2 });
    const gateway = installFakeGateway();
    const first = await startPaymentFor(alice, orderId, gateway);
    await app.applyPaymentResult(gateway.settle(first, "succeeded"));
    await app.shipOrder(await mintAccessJwt(), { orderId });
    const second = await seedPayment(orderId, "pending", "pay_dup");
    gateway.adopt(second, { amountTwd: totalTwd, merchantReference: String(orderId) });

    await app.applyPaymentResult(gateway.settle(second, "succeeded"));

    expect(await stockOf(variantId)).toEqual({ onHand: 8, available: 8 });
    expect(gateway.refunded).toEqual([second]);
    expect(await adminPayments(orderId)).toMatchObject([
      { status: "succeeded", needsAttention: false },
      { status: "refunded", refundReason: "duplicate_success", needsAttention: false },
    ]);
    expect((await orderOf(alice, orderId)).status).toBe("shipped");
  });
});
