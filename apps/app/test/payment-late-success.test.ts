import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOrderService } from "../src/orders/service";
import { createHttpGateway } from "../src/payments/gateway";
import { createPaymentService } from "../src/payments/service";
import { systemClock } from "../src/shared/clock";
import { mintAccessJwt } from "./access";
import { TEST_GATEWAY_API_KEY, TEST_GATEWAY_BASE_URL } from "./constants";
import { setNow } from "./clock";
import { signInCustomer } from "./customers";
import { checkoutInput } from "./checkout-helpers";
import { forceOrderStatus, forcePaymentStatus, resetDb, seedPayment } from "./db";
import { installFakeGateway } from "./fake-gateway";
import { orderOf, placeMugOrder, startPaymentFor } from "./payment-helpers";
import { app, PAYMENT_WINDOW_MS, placeOrderAt, PRICE, runCron, stocked, stockOf } from "./release-helpers";
import { seedImageAndList } from "./images";

const T0 = Date.now() + 60_000;

/** 測試期間 App 記下的結構化事件（console 的 JSON 行）。 */
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

/**
 * 安排「遲到的付款成功」：訂單成立、付款發起、付款期限過了由 Cron 轉為已逾期，
 * 之後（`late` 時間點）才由閘道送來成功事件（尚未套用）。
 */
async function lateSuccessSetup({ onHand = 10, quantity = 2 } = {}) {
  const alice = await signInCustomer("alice");
  const productId = await stocked(onHand);
  const order = await placeOrderAt(alice, productId, quantity, T0);
  const gateway = installFakeGateway();
  setNow(T0 + 1_000);
  const gatewayPaymentId = await startPaymentFor(alice, order.orderId, gateway);
  await runCron(order.paymentDeadline);
  const event = gateway.settle(gatewayPaymentId, "succeeded");
  setNow(order.paymentDeadline + 5_000);
  return { alice, productId, orderId: order.orderId, gateway, event, gatewayPaymentId };
}

describe("遲到的付款成功：重新保留", () => {
  beforeEach(resetDb);
  afterEach(() => vi.restoreAllMocks());

  it("有庫存：已逾期的訂單轉為已付款，在庫數扣除，不退款", async () => {
    const { alice, orderId, productId, gateway, event } = await lateSuccessSetup({ onHand: 10, quantity: 2 });
    expect((await orderOf(alice, orderId)).status).toBe("expired");
    expect(await stockOf(productId)).toEqual({ onHand: 10, available: 10 });

    const result = await app.applyPaymentResult(event);

    expect(result).toEqual({ ok: true, data: { paymentStatus: "succeeded", orderStatus: "paid" } });
    expect(await stockOf(productId)).toEqual({ onHand: 8, available: 8 });
    const order = await orderOf(alice, orderId);
    expect(order.status).toBe("paid");
    expect(order.payments).toMatchObject([{ status: "succeeded", refundReason: null }]);
    expect(gateway.refunded).toEqual([]);
  });

  it("庫存被別的待付款訂單保留走：訂單維持已逾期、在庫數不動，付款記成功後退款（late_success_unreclaimable）", async () => {
    const { alice, orderId, productId, gateway, event, gatewayPaymentId } = await lateSuccessSetup({ onHand: 3, quantity: 2 });
    const bob = await signInCustomer("bob");
    await placeOrderAt(bob, productId, 2, T0 + PAYMENT_WINDOW_MS + 6_000);
    expect(await stockOf(productId)).toEqual({ onHand: 3, available: 1 });

    const result = await app.applyPaymentResult(event);

    expect(result).toEqual({ ok: true, data: { paymentStatus: "refunded", orderStatus: "expired" } });
    expect(await stockOf(productId)).toEqual({ onHand: 3, available: 1 });
    const order = await orderOf(alice, orderId);
    expect(order.status).toBe("expired");
    expect(order.payments).toMatchObject([{ status: "refunded", refundReason: "late_success_unreclaimable" }]);
    expect(gateway.refunded).toEqual([gatewayPaymentId]);
  });

  it("重新保留是全有全無：多筆明細只要有一筆庫存不夠，整張都不重新保留（有貨的那一筆也不扣）", async () => {
    const alice = await signInCustomer("alice");
    const mug = await stocked(10);
    const plate = await stocked(2);
    const created = await app.checkout(alice, checkoutInput([
      { productId: mug, quantity: 2, seenUnitPriceTwd: PRICE },
      { productId: plate, quantity: 2, seenUnitPriceTwd: PRICE },
    ]));
    if (!created.ok) throw new Error("結帳失敗");
    const gateway = installFakeGateway();
    setNow(Date.now() + 1_000);
    const gatewayPaymentId = await startPaymentFor(alice, created.data.orderId, gateway);
    await runCron(created.data.paymentDeadline);
    const event = gateway.settle(gatewayPaymentId, "succeeded");
    // 別人把盤子保留走，馬克杯仍有貨
    const bob = await signInCustomer("bob");
    await placeOrderAt(bob, plate, 1, created.data.paymentDeadline + 1_000);

    const result = await app.applyPaymentResult(event);

    expect(result).toEqual({ ok: true, data: { paymentStatus: "refunded", orderStatus: "expired" } });
    expect(await stockOf(mug)).toEqual({ onHand: 10, available: 10 });
    expect(await stockOf(plate)).toEqual({ onHand: 2, available: 1 });
    expect(gateway.refunded).toEqual([gatewayPaymentId]);
  });
});

describe("退款的結果與觸發", () => {
  beforeEach(resetDb);
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ["閘道回 502", 502],
    ["連不上閘道", 0],
  ])("退款失敗（%s）：付款記 refund_failed 與原因，訂單不動，並記一行結構化 log", async (_label, status) => {
    const { alice, orderId, productId, gateway, event, gatewayPaymentId } = await lateSuccessSetup({ onHand: 3, quantity: 2 });
    const bob = await signInCustomer("bob");
    await placeOrderAt(bob, productId, 2, T0 + PAYMENT_WINDOW_MS + 6_000);
    gateway.failNext("refund", status);
    const errors = vi.spyOn(console, "error");

    const result = await app.applyPaymentResult(event);

    expect(result).toEqual({ ok: true, data: { paymentStatus: "refund_failed", orderStatus: "expired" } });
    const order = await orderOf(alice, orderId);
    expect(order.status).toBe("expired");
    expect(order.payments).toMatchObject([{ status: "refund_failed", refundReason: "late_success_unreclaimable" }]);
    expect(loggedEvents(errors, "payment_refund_failed")).toEqual([
      { event: "payment_refund_failed", orderId, gatewayPaymentId, reason: "late_success_unreclaimable" },
    ]);
  });

  it("付款設定不全（沒有閘道）：退不了款，付款記 refund_failed 並記 log，不丟例外", async () => {
    const { alice, orderId, productId, event } = await lateSuccessSetup({ onHand: 3, quantity: 2 });
    const bob = await signInCustomer("bob");
    await placeOrderAt(bob, productId, 2, T0 + PAYMENT_WINDOW_MS + 6_000);
    const errors = vi.spyOn(console, "error");
    const service = createPaymentService(env.DB, { now: () => Date.now() }, async () => null, null, "http://localhost:4321");

    const result = await service.applyPaymentResult(event);

    expect(result).toEqual({ ok: true, data: { paymentStatus: "refund_failed", orderStatus: "expired" } });
    expect((await orderOf(alice, orderId)).payments).toMatchObject([{ status: "refund_failed", refundReason: "late_success_unreclaimable" }]);
    expect(loggedEvents(errors, "payment_refund_failed")).toMatchObject([{ code: "payment_unavailable" }]);
  });

  it("已取消的訂單收到付款成功：訂單維持已取消、在庫數不動，付款退款（cancelled_order）", async () => {
    const alice = await signInCustomer("alice");
    const { orderId, productId } = await placeMugOrder(alice, { onHand: 10, quantity: 2 });
    const gateway = installFakeGateway();
    const gatewayPaymentId = await startPaymentFor(alice, orderId, gateway);
    // 取消與新付款的競態才會留下「已取消訂單上還有進行中的付款」，這裡直接安排
    await forceOrderStatus(orderId, "cancelled");

    const result = await app.applyPaymentResult(gateway.settle(gatewayPaymentId, "succeeded"));

    expect(result).toEqual({ ok: true, data: { paymentStatus: "refunded", orderStatus: "cancelled" } });
    expect(await stockOf(productId)).toEqual({ onHand: 10, available: 10 });
    const order = await orderOf(alice, orderId);
    expect(order.status).toBe("cancelled");
    expect(order.payments).toMatchObject([{ status: "refunded", refundReason: "cancelled_order" }]);
    expect(gateway.refunded).toEqual([gatewayPaymentId]);
  });

  it("同一訂單第二筆成功付款：在庫數只扣一次，第二筆退款（duplicate_success），第一筆維持成功", async () => {
    const alice = await signInCustomer("alice");
    const { orderId, productId, totalTwd } = await placeMugOrder(alice, { onHand: 10, quantity: 2 });
    const gateway = installFakeGateway();
    const first = await startPaymentFor(alice, orderId, gateway);
    // 發起新付款會先取消前一筆；「兩筆同時進行」只能直接安排
    const second = await seedPayment(orderId, "pending", "pay_second");
    gateway.adopt(second, { amountTwd: totalTwd, merchantReference: String(orderId) });

    await app.applyPaymentResult(gateway.settle(first, "succeeded"));
    const result = await app.applyPaymentResult(gateway.settle(second, "succeeded"));

    expect(result).toEqual({ ok: true, data: { paymentStatus: "refunded", orderStatus: "paid" } });
    expect(await stockOf(productId)).toEqual({ onHand: 8, available: 8 });
    const order = await orderOf(alice, orderId);
    expect(order.status).toBe("paid");
    expect(order.payments).toMatchObject([
      { status: "succeeded", refundReason: null },
      { status: "refunded", refundReason: "duplicate_success" },
    ]);
    expect(gateway.refunded).toEqual([second]);
  });

  it("退款原因以 batch 當下的訂單狀態為準：batch 與退款之間訂單被別的動作轉走，原因不變", async () => {
    const { alice, orderId, productId, event } = await lateSuccessSetup({ onHand: 3, quantity: 2 });
    const bob = await signInCustomer("bob");
    await placeOrderAt(bob, productId, 2, T0 + PAYMENT_WINDOW_MS + 6_000);
    // 在 batch 之後、退款之前，把訂單改成已付款（模擬另一個呼叫剛好搶先重新保留）；若退款原因是 batch 之後才另外讀訂單，會誤判成 duplicate_success
    const interleaved = {
      prepare: (query: string) => env.DB.prepare(query),
      batch: async (statements: D1PreparedStatement[]) => {
        const results = await env.DB.batch(statements);
        await forceOrderStatus(orderId, "paid");
        return results;
      },
    } as unknown as D1Database;
    const service = createPaymentService(
      interleaved,
      systemClock,
      async () => null,
      createHttpGateway({ baseUrl: TEST_GATEWAY_BASE_URL, apiKey: TEST_GATEWAY_API_KEY }),
      "http://localhost:4321",
    );

    await service.applyPaymentResult(event);

    expect((await orderOf(alice, orderId)).payments).toMatchObject([{ status: "refunded", refundReason: "late_success_unreclaimable" }]);
  });

  it("退款結果沒能記下（付款已不是 succeeded）：記 payment_refund_unrecorded，不記 payment_refunded", async () => {
    const { orderId, productId, event, gatewayPaymentId, gateway } = await lateSuccessSetup({ onHand: 3, quantity: 2 });
    const bob = await signInCustomer("bob");
    await placeOrderAt(bob, productId, 2, T0 + PAYMENT_WINDOW_MS + 6_000);
    // 閘道退款進行中，付款被別的動作改成別的狀態（例如後台處理），條件式記錄就寫不進去
    gateway.onRefund = () => forcePaymentStatus(gatewayPaymentId, "failed");
    const logs = vi.spyOn(console, "log");
    const errors = vi.spyOn(console, "error");

    await app.applyPaymentResult(event);

    expect(loggedEvents(errors, "payment_refund_unrecorded")).toEqual([
      { event: "payment_refund_unrecorded", orderId, gatewayPaymentId, reason: "late_success_unreclaimable" },
    ]);
    expect(loggedEvents(logs, "payment_refunded")).toEqual([]);
  });

  it("同一事件重送（含同時送達）：只退款一次，回同一結果", async () => {
    const { orderId, alice, productId, gateway, event } = await lateSuccessSetup({ onHand: 3, quantity: 2 });
    const bob = await signInCustomer("bob");
    await placeOrderAt(bob, productId, 2, T0 + PAYMENT_WINDOW_MS + 6_000);

    const first = await app.applyPaymentResult(event);
    const again = await app.applyPaymentResult(event);
    const concurrent = await Promise.all([1, 2, 3].map(() => app.applyPaymentResult(event)));

    expect(again).toEqual(first);
    for (const result of concurrent) expect(result).toEqual(first);
    expect(gateway.refunded).toHaveLength(1);
    expect((await orderOf(alice, orderId)).payments).toMatchObject([{ status: "refunded" }]);
  });
});

describe("遲到的付款成功與結帳搶最後一件：兩種先後各自的結果", () => {
  beforeEach(resetDb);
  afterEach(() => vi.restoreAllMocks());

  // 並行測試只驗不變量：實測時兩邊的先後並不平均（結帳要先驗 session，幾乎總是落後），不能靠它保證兩種結果都走過，所以各寫一個確定先後的測試。
  it("重新保留先到：訂單轉已付款、在庫數扣除，之後的結帳因可售數量不足被拒", async () => {
    const { alice, orderId, productId, gateway, event } = await lateSuccessSetup({ onHand: 1, quantity: 1 });
    const bob = await signInCustomer("bob");

    await app.applyPaymentResult(event);
    const checkout = await app.checkout(bob, checkoutInput([{ productId, quantity: 1, seenUnitPriceTwd: PRICE }]));

    expect(checkout).toMatchObject({ ok: false, reason: "checkout_rejected" });
    expect((await orderOf(alice, orderId)).status).toBe("paid");
    expect(await stockOf(productId)).toEqual({ onHand: 0, available: 0 });
    expect(gateway.refunded).toEqual([]);
  });

  it("結帳先到：結帳成功保留了最後一件，之後的重新保留不到，付款退款（late_success_unreclaimable）", async () => {
    const { alice, orderId, productId, gateway, event, gatewayPaymentId } = await lateSuccessSetup({ onHand: 1, quantity: 1 });
    const bob = await signInCustomer("bob");

    const checkout = await app.checkout(bob, checkoutInput([{ productId, quantity: 1, seenUnitPriceTwd: PRICE }]));
    await app.applyPaymentResult(event);

    expect(checkout).toMatchObject({ ok: true });
    const order = await orderOf(alice, orderId);
    expect(order.status).toBe("expired");
    expect(order.payments).toMatchObject([{ status: "refunded", refundReason: "late_success_unreclaimable" }]);
    expect(await stockOf(productId)).toEqual({ onHand: 1, available: 0 });
    expect(gateway.refunded).toEqual([gatewayPaymentId]);
  });
});

describe("遲到的付款成功與結帳搶最後一件並行", () => {
  beforeEach(resetDb);
  afterEach(() => vi.restoreAllMocks());

  it("在庫 1：每個商品都恰好一方拿到（重新保留成功或結帳成功），不超賣，落敗的付款被退款", async () => {
    const rounds = 100;
    // 100 組並行會各記幾行結構化 log，與這個測試要驗的無關
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const alice = await signInCustomer("alice");
    const bob = await signInCustomer("bob");
    const gateway = installFakeGateway();
    const scenarios: { productId: number; orderId: number; gatewayPaymentId: string }[] = [];
    // 安排前置狀態走 service 並以固定身分取代 session 驗證（每次 RPC 都驗 session，100 組會慢上好幾倍），競爭的那一段仍走 RPC
    const { customer } = await app.getCustomerSession(alice);
    const asAlice = async () => customer!.customerId;
    const orderService = createOrderService(env.DB, systemClock, asAlice, async () => null);
    const setupPayments = createPaymentService(
      env.DB,
      systemClock,
      asAlice,
      createHttpGateway({ baseUrl: TEST_GATEWAY_BASE_URL, apiKey: TEST_GATEWAY_API_KEY }),
      "http://localhost:4321",
    );
    const jwt = await mintAccessJwt();
    // 每個商品在庫 1，各有一張已逾期、付款成功事件還沒套用的訂單（不占保留，可售數量 1）
    for (let i = 0; i < rounds; i += 1) {
      const created = await app.createProduct(jwt, { name: "馬克杯", description: "說明", priceTwd: PRICE });
      if (!created.ok) throw new Error("新增商品失敗");
      const productId = created.data.id;
      await seedImageAndList(jwt, productId);
      await app.adjustStock(jwt, { id: productId, delta: 1 });
      setNow(T0 + i);
      const placed = await orderService.checkout("alice", checkoutInput([{ productId, quantity: 1, seenUnitPriceTwd: PRICE }]));
      if (!placed.ok) throw new Error("結帳失敗");
      setNow(T0 + i + 500);
      const started = await setupPayments.startPayment("alice", { orderId: placed.data.orderId });
      if (!started.ok) throw new Error("發起付款失敗");
      scenarios.push({ productId, orderId: placed.data.orderId, gatewayPaymentId: gateway.lastPaymentId() });
    }
    await runCron(T0 + rounds + PAYMENT_WINDOW_MS);
    const events = scenarios.map(({ gatewayPaymentId }) => gateway.settle(gatewayPaymentId, "succeeded"));
    setNow(T0 + rounds + PAYMENT_WINDOW_MS + 5_000);

    // 重新保留與結帳同時送出，兩邊的語句在 D1 上可能交錯（交錯與否不保證；改成 service 直呼時交錯變少，先讀後寫的變異抓不到）。
    // 不論怎麼交錯，下面的不變量都必須成立
    await Promise.all(
      scenarios.flatMap(({ productId }, i) => [
        app.checkout(bob, checkoutInput([{ productId, quantity: 1, seenUnitPriceTwd: PRICE }])),
        app.applyPaymentResult(events[i]),
      ]),
    );

    const bobListed = await app.listMyOrders(bob);
    const aliceListed = await app.listMyOrders(alice);
    const stocks = await app.listProductsForAdmin(await mintAccessJwt());
    if (!bobListed.ok || !aliceListed.ok || !stocks.ok) throw new Error("讀取失敗");
    const bobProducts = new Set(bobListed.data.flatMap((order) => order.lines.map((line) => line.productId)));
    const alicePaid = new Set(aliceListed.data.filter((order) => order.status === "paid").map((order) => order.id));
    for (const { productId, orderId, gatewayPaymentId } of scenarios) {
      const aliceHasIt = alicePaid.has(orderId);
      expect(aliceHasIt !== bobProducts.has(productId), `商品 ${productId} 應恰好一方拿到`).toBe(true);
      const stock = stocks.data.find((product) => product.id === productId)!;
      expect(stock.available, `商品 ${productId} 可售數量不可為負`).toBeGreaterThanOrEqual(0);
      expect(stock.onHand).toBe(aliceHasIt ? 0 : 1);
      expect(gateway.refunded.includes(gatewayPaymentId)).toBe(!aliceHasIt);
    }
  }, 60_000);
});
