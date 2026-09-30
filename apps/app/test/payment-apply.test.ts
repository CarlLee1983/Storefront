import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setNow } from "./clock";
import { signInCustomer } from "./customers";
import { forceOrderStatus, resetDb, seedPayment } from "./db";
import { installFakeGateway, type FakeGateway } from "./fake-gateway";
import { orderOf, placeMugOrder, stockOf } from "./payment-helpers";

const app = exports.default;

/** 發起一筆付款，回傳閘道付款 ID。 */
async function startPayment(cookie: string, orderId: number, gateway: FakeGateway): Promise<string> {
  const started = await app.startPayment(cookie, { orderId });
  if (!started.ok) throw new Error(`發起付款失敗：${started.reason}`);
  return gateway.lastPaymentId();
}

/** 測試期間 App 記下的結構化事件（console.log 的 JSON 行）。 */
function loggedEvents(spy: { mock: { calls: unknown[][] } }, event: string): unknown[] {
  return spy.mock.calls
    .map(([line]) => {
      try {
        return JSON.parse(String(line)) as { event?: string };
      } catch {
        return {};
      }
    })
    .filter((entry) => entry.event === event);
}

describe("applyPaymentResult：付款成功", () => {
  beforeEach(resetDb);
  afterEach(() => vi.restoreAllMocks());

  it("待付款訂單轉為已付款：保留轉為正式扣除在庫數，可售數量不變", async () => {
    const alice = await signInCustomer("alice");
    const { orderId, productId } = await placeMugOrder(alice, { onHand: 10, quantity: 2 });
    const gateway = installFakeGateway();
    const gatewayPaymentId = await startPayment(alice, orderId, gateway);
    expect(await stockOf(productId)).toEqual({ onHand: 10, available: 8 });

    const result = await app.applyPaymentResult(gateway.settle(gatewayPaymentId, "succeeded"));

    expect(result).toEqual({ ok: true, data: { paymentStatus: "succeeded", orderStatus: "paid" } });
    expect(await stockOf(productId)).toEqual({ onHand: 8, available: 8 });
    const order = await orderOf(alice, orderId);
    expect(order.status).toBe("paid");
    expect(order.payments).toMatchObject([{ status: "succeeded" }]);
  });

  it("多筆明細：每一筆的數量都從各自商品的在庫數扣除", async () => {
    const alice = await signInCustomer("alice");
    const { orderId, productId: mug } = await placeMugOrder(alice, { onHand: 10, quantity: 2 });
    const other = await signInCustomer("bob");
    const { orderId: otherOrderId, productId: otherMug } = await placeMugOrder(other, { onHand: 5, quantity: 3 });
    const gateway = installFakeGateway();
    const gatewayPaymentId = await startPayment(alice, orderId, gateway);

    await app.applyPaymentResult(gateway.settle(gatewayPaymentId, "succeeded"));

    expect(await stockOf(mug)).toEqual({ onHand: 8, available: 8 });
    // 別人的訂單與商品不受影響
    expect(await stockOf(otherMug)).toEqual({ onHand: 5, available: 2 });
    expect((await orderOf(other, otherOrderId)).status).toBe("pending_payment");
  });

  it("付款期限已過、Cron 尚未轉逾期（訂單仍是待付款）：照常轉為已付款", async () => {
    const alice = await signInCustomer("alice");
    const { orderId } = await placeMugOrder(alice);
    const gateway = installFakeGateway();
    const gatewayPaymentId = await startPayment(alice, orderId, gateway);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 30 * 60 * 1000);

    expect(await app.applyPaymentResult(gateway.settle(gatewayPaymentId, "succeeded"))).toMatchObject({
      ok: true,
      data: { orderStatus: "paid" },
    });
  });
});

describe("applyPaymentResult：付款失敗", () => {
  beforeEach(resetDb);
  afterEach(() => vi.restoreAllMocks());

  it("付款記為失敗，訂單仍是待付款、保留與在庫數不動，可以再付一次", async () => {
    const alice = await signInCustomer("alice");
    const { orderId, productId } = await placeMugOrder(alice, { onHand: 10, quantity: 2 });
    const gateway = installFakeGateway();
    const gatewayPaymentId = await startPayment(alice, orderId, gateway);

    const result = await app.applyPaymentResult(gateway.settle(gatewayPaymentId, "failed"));

    expect(result).toEqual({ ok: true, data: { paymentStatus: "failed", orderStatus: "pending_payment" } });
    expect(await stockOf(productId)).toEqual({ onHand: 10, available: 8 });
    expect((await orderOf(alice, orderId)).payments).toMatchObject([{ status: "failed" }]);

    const retry = await startPayment(alice, orderId, gateway);
    await app.applyPaymentResult(gateway.settle(retry, "succeeded"));
    const order = await orderOf(alice, orderId);
    expect(order.status).toBe("paid");
    expect(order.payments).toMatchObject([{ status: "failed" }, { status: "succeeded" }]);
    expect(await stockOf(productId)).toEqual({ onHand: 8, available: 8 });
  });

  it("付款已成功之後，另一個事件說它失敗：付款維持成功（狀態只往前走）", async () => {
    const alice = await signInCustomer("alice");
    const { orderId } = await placeMugOrder(alice);
    const gateway = installFakeGateway();
    const gatewayPaymentId = await startPayment(alice, orderId, gateway);
    await app.applyPaymentResult(gateway.settle(gatewayPaymentId, "succeeded"));

    const result = await app.applyPaymentResult({ eventId: "evt_stray", gatewayPaymentId, outcome: "failed" });

    expect(result).toEqual({ ok: true, data: { paymentStatus: "succeeded", orderStatus: "paid" } });
  });
});

describe("applyPaymentResult：冪等與並行", () => {
  beforeEach(resetDb);
  afterEach(() => vi.restoreAllMocks());

  it("同一事件重送：只套用一次，回同一結果，在庫數只扣一次", async () => {
    const alice = await signInCustomer("alice");
    const { orderId, productId } = await placeMugOrder(alice, { onHand: 10, quantity: 2 });
    const gateway = installFakeGateway();
    const event = gateway.settle(await startPayment(alice, orderId, gateway), "succeeded");

    const first = await app.applyPaymentResult(event);
    const second = await app.applyPaymentResult(event);
    const third = await app.applyPaymentResult(event);

    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(await stockOf(productId)).toEqual({ onHand: 8, available: 8 });
  });

  it("同一事件同時送達多次（Promise.all）：只套用一次，結果一致，在庫數只扣一次", async () => {
    const alice = await signInCustomer("alice");
    const { orderId, productId } = await placeMugOrder(alice, { onHand: 10, quantity: 2 });
    const gateway = installFakeGateway();
    const event = gateway.settle(await startPayment(alice, orderId, gateway), "succeeded");

    const results = await Promise.all([1, 2, 3, 4, 5].map(() => app.applyPaymentResult(event)));

    for (const result of results) expect(result).toEqual({ ok: true, data: { paymentStatus: "succeeded", orderStatus: "paid" } });
    expect(await stockOf(productId)).toEqual({ onHand: 8, available: 8 });
  });

  it("兩筆付款都成功（同時送達）：只有一筆讓訂單轉已付款，在庫數只扣一次，另一筆記下事件留給退款處理", async () => {
    const alice = await signInCustomer("alice");
    const { orderId, productId } = await placeMugOrder(alice, { onHand: 10, quantity: 2 });
    const gateway = installFakeGateway();
    const first = await startPayment(alice, orderId, gateway);
    // 發起新付款會取消前一筆；「兩筆付款同時都是 pending」（例如取消晚了一步、顧客其實已付款）只能直接安排
    const second = await seedPayment(orderId, "pending");
    const log = vi.spyOn(console, "log");

    await Promise.all([
      app.applyPaymentResult(gateway.settle(first, "succeeded")),
      app.applyPaymentResult({ eventId: "evt_second", gatewayPaymentId: second, outcome: "succeeded" }),
    ]);

    expect(await stockOf(productId)).toEqual({ onHand: 8, available: 8 });
    const order = await orderOf(alice, orderId);
    expect(order.status).toBe("paid");
    expect(order.payments).toMatchObject([{ status: "succeeded" }, { status: "succeeded" }]);
    expect(loggedEvents(log, "payment_succeeded_on_non_pending_order")).toHaveLength(1);
  });
});

describe("applyPaymentResult：訂單已不是待付款", () => {
  beforeEach(resetDb);
  afterEach(() => vi.restoreAllMocks());

  it.each(["expired", "cancelled"])(
    "訂單是 %s：付款記為成功，訂單與在庫數不動，記一行 payment_succeeded_on_non_pending_order（重送不重複記）",
    async (status) => {
      const alice = await signInCustomer("alice");
      const { orderId, productId } = await placeMugOrder(alice, { onHand: 10, quantity: 2 });
      const gateway = installFakeGateway();
      const gatewayPaymentId = await startPayment(alice, orderId, gateway);
      await forceOrderStatus(orderId, status);
      const before = await stockOf(productId);
      const log = vi.spyOn(console, "log");
      const event = gateway.settle(gatewayPaymentId, "succeeded");

      const result = await app.applyPaymentResult(event);
      await app.applyPaymentResult(event);

      expect(result).toEqual({ ok: true, data: { paymentStatus: "succeeded", orderStatus: status } });
      expect(await stockOf(productId)).toEqual(before);
      const order = await orderOf(alice, orderId);
      expect(order.status).toBe(status);
      expect(order.payments).toMatchObject([{ status: "succeeded" }]);
      expect(loggedEvents(log, "payment_succeeded_on_non_pending_order")).toEqual([
        { event: "payment_succeeded_on_non_pending_order", orderId, gatewayPaymentId, orderStatus: status },
      ]);
    },
  );
});

describe("已取消訂單上的付款摘要", () => {
  beforeEach(resetDb);
  afterEach(() => vi.restoreAllMocks());

  it("顧客取消訂單後，付款嘗試仍照實顯示；之後付款成功落在已取消的訂單上，顯示成功、訂單維持已取消、在庫數不動", async () => {
    const alice = await signInCustomer("alice");
    const { orderId, productId } = await placeMugOrder(alice, { onHand: 10, quantity: 2 });
    const gateway = installFakeGateway();
    const gatewayPaymentId = await startPayment(alice, orderId, gateway);

    expect(await app.cancelOrder(alice, { orderId })).toMatchObject({ ok: true });
    const afterCancel = await orderOf(alice, orderId);
    expect(afterCancel.status).toBe("cancelled");
    expect(afterCancel.payments).toMatchObject([{ status: "pending" }]);

    await app.applyPaymentResult(gateway.settle(gatewayPaymentId, "succeeded"));

    const order = await orderOf(alice, orderId);
    expect(order.status).toBe("cancelled");
    expect(order.payments).toMatchObject([{ status: "succeeded" }]);
    expect(await stockOf(productId)).toEqual({ onHand: 10, available: 10 });
  });
});

describe("applyPaymentResult：時間", () => {
  beforeEach(resetDb);
  afterEach(() => vi.restoreAllMocks());

  it("事件的套用時間用高水位時鐘的有效時間：系統時鐘倒退也不會記到比高水位更早（唯一直接讀資料表的斷言：套用時間沒有 RPC 可讀）", async () => {
    const alice = await signInCustomer("alice");
    const created = Date.now();
    setNow(created);
    const { orderId } = await placeMugOrder(alice);
    const gateway = installFakeGateway();
    const gatewayPaymentId = await startPayment(alice, orderId, gateway);
    setNow(created + 5_000);
    await app.startPayment(alice, { orderId }); // 把高水位推到 created + 5 秒
    const event = gateway.settle(gatewayPaymentId, "failed");

    setNow(created + 1_000); // 系統時鐘倒退
    await app.applyPaymentResult(event);

    const row = await env.DB.prepare("SELECT applied_at FROM payment_events WHERE event_id = ?").bind(event.eventId).first<{ applied_at: number }>();
    expect(row?.applied_at).toBe(created + 5_000);
  });
});

describe("applyPaymentResult：輸入與未知的付款", () => {
  beforeEach(resetDb);
  afterEach(() => vi.restoreAllMocks());

  it("閘道付款 ID 不存在：payment_not_found，事件不記錄（之後付款存在時同一事件仍可套用）", async () => {
    expect(await app.applyPaymentResult({ eventId: "evt_1", gatewayPaymentId: "pay_missing", outcome: "succeeded" })).toEqual({
      ok: false,
      reason: "payment_not_found",
    });
  });

  it.each([
    ["缺 eventId", { gatewayPaymentId: "pay_1", outcome: "succeeded" }],
    ["outcome 不合法", { eventId: "evt_1", gatewayPaymentId: "pay_1", outcome: "refunded" }],
    ["事件 ID 含奇怪字元", { eventId: "evt 1;", gatewayPaymentId: "pay_1", outcome: "failed" }],
    ["不是物件", null],
  ])("輸入不合法（%s）：invalid_input", async (_label, input) => {
    expect(await app.applyPaymentResult(input)).toMatchObject({ ok: false, reason: "invalid_input" });
  });
});
