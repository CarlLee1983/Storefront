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
import { forceOrderStatus, resetDb, seedPayment } from "./db";
import { installFakeGateway } from "./fake-gateway";
import { noInvoices, orderOf, placeMugOrder, startPaymentFor } from "./payment-helpers";
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
  const variantId = await stocked(onHand);
  const order = await placeOrderAt(alice, variantId, quantity, T0);
  const gateway = installFakeGateway();
  setNow(T0 + 1_000);
  const gatewayPaymentId = await startPaymentFor(alice, order.orderId, gateway);
  await runCron(order.paymentDeadline);
  const event = gateway.settle(gatewayPaymentId, "succeeded");
  setNow(order.paymentDeadline + 5_000);
  return { alice, variantId, orderId: order.orderId, gateway, event, gatewayPaymentId };
}

describe("遲到的付款成功：重新保留", () => {
  beforeEach(resetDb);
  afterEach(() => vi.restoreAllMocks());

  it("有庫存：已逾期的訂單轉為已付款，轉為已付款保留（在庫數不動），不退款", async () => {
    const { alice, orderId, variantId, gateway, event } = await lateSuccessSetup({ onHand: 10, quantity: 2 });
    expect((await orderOf(alice, orderId)).status).toBe("expired");
    expect(await stockOf(variantId)).toEqual({ onHand: 10, available: 10 });

    const result = await app.applyPaymentResult(event);

    expect(result).toEqual({ ok: true, data: { paymentStatus: "succeeded", orderStatus: "paid" } });
    expect(await stockOf(variantId)).toEqual({ onHand: 10, available: 8 });
    const order = await orderOf(alice, orderId);
    expect(order.status).toBe("paid");
    expect(order.payments).toMatchObject([{ status: "succeeded" }]);
    expect(order.refunds).toEqual([]);
    expect(gateway.refunded).toEqual([]);
  });

  it("庫存被別的待付款訂單保留走：訂單維持已逾期、在庫數不動，付款記成功後退款（late_success_unreclaimable）", async () => {
    const { alice, orderId, variantId, gateway, event, gatewayPaymentId } = await lateSuccessSetup({ onHand: 3, quantity: 2 });
    const bob = await signInCustomer("bob");
    await placeOrderAt(bob, variantId, 2, T0 + PAYMENT_WINDOW_MS + 6_000);
    expect(await stockOf(variantId)).toEqual({ onHand: 3, available: 1 });

    const result = await app.applyPaymentResult(event);

    expect(result).toEqual({ ok: true, data: { paymentStatus: "succeeded", orderStatus: "expired" } });
    expect(await stockOf(variantId)).toEqual({ onHand: 3, available: 1 });
    const order = await orderOf(alice, orderId);
    expect(order.status).toBe("expired");
    expect(order.refunds).toMatchObject([{ status: "succeeded", reason: "late_success_unreclaimable" }]);
    expect(gateway.refunded).toEqual([gatewayPaymentId]);
  });

  it("重新保留是全有全無：多筆明細只要有一筆庫存不夠，整張都不重新保留（有貨的那一筆也不扣）", async () => {
    const alice = await signInCustomer("alice");
    const mug = await stocked(10);
    const plate = await stocked(2);
    const created = await app.checkout(alice, checkoutInput([
      { variantId: mug, quantity: 2, seenUnitPriceTwd: PRICE },
      { variantId: plate, quantity: 2, seenUnitPriceTwd: PRICE },
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

    expect(result).toEqual({ ok: true, data: { paymentStatus: "succeeded", orderStatus: "expired" } });
    expect(await stockOf(mug)).toEqual({ onHand: 10, available: 10 });
    expect(await stockOf(plate)).toEqual({ onHand: 2, available: 1 });
    expect(gateway.refunded).toEqual([gatewayPaymentId]);
  });

  it("不可售數量不算可售：在庫夠但被待檢或損壞的退貨占住，遲到付款重新保留不到，退款而不重新保留", async () => {
    const { alice, orderId, variantId, gateway, event, gatewayPaymentId } = await lateSuccessSetup({ onHand: 3, quantity: 2 });
    await env.DB.prepare("UPDATE product_variants SET unavailable = 2 WHERE id = ?").bind(variantId).run();

    const result = await app.applyPaymentResult(event);

    expect(result).toEqual({ ok: true, data: { paymentStatus: "succeeded", orderStatus: "expired" } });
    expect((await orderOf(alice, orderId)).refunds).toMatchObject([{ status: "succeeded", reason: "late_success_unreclaimable" }]);
    expect(gateway.refunded).toEqual([gatewayPaymentId]);
  });

  it("庫存被另一張已付款未出貨的訂單占住：遲到付款重新保留不到，退款（late_success_unreclaimable），在庫數維持 1", async () => {
    const { alice, orderId, variantId, gateway, event, gatewayPaymentId } = await lateSuccessSetup({ onHand: 1, quantity: 1 });
    const bob = await signInCustomer("bob");
    const bobOrder = await placeOrderAt(bob, variantId, 1, T0 + PAYMENT_WINDOW_MS + 6_000);
    await forceOrderStatus(bobOrder.orderId, "paid");
    expect(await stockOf(variantId)).toEqual({ onHand: 1, available: 0 });

    const result = await app.applyPaymentResult(event);

    expect(result).toEqual({ ok: true, data: { paymentStatus: "succeeded", orderStatus: "expired" } });
    expect(await stockOf(variantId)).toEqual({ onHand: 1, available: 0 });
    expect((await orderOf(alice, orderId)).refunds).toMatchObject([{ status: "succeeded", reason: "late_success_unreclaimable" }]);
    expect(gateway.refunded).toEqual([gatewayPaymentId]);
  });
});

describe("退款的結果與觸發", () => {
  beforeEach(resetDb);
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ["閘道回 502（非明確失敗碼）", 502],
    ["連不上閘道", 0],
  ])("退款結果不明（%s）：退款記 unknown 並留下嘗試紀錄，付款維持成功、訂單不動", async (_label, status) => {
    const { alice, orderId, variantId, gateway, event } = await lateSuccessSetup({ onHand: 3, quantity: 2 });
    const bob = await signInCustomer("bob");
    await placeOrderAt(bob, variantId, 2, T0 + PAYMENT_WINDOW_MS + 6_000);
    gateway.failNext("refund", status);

    const result = await app.applyPaymentResult(event);

    expect(result).toEqual({ ok: true, data: { paymentStatus: "succeeded", orderStatus: "expired" } });
    const order = await orderOf(alice, orderId);
    expect(order.status).toBe("expired");
    expect(order.refunds).toMatchObject([{ status: "unknown", reason: "late_success_unreclaimable", settledAt: null }]);
    expect(gateway.refunded).toEqual([]);
  });

  it("閘道明確拒絕退款：退款記 failed（保留額度），付款維持成功、訂單不動，管理端標示需要處理", async () => {
    const { alice, orderId, variantId, gateway, event } = await lateSuccessSetup({ onHand: 3, quantity: 2 });
    const bob = await signInCustomer("bob");
    await placeOrderAt(bob, variantId, 2, T0 + PAYMENT_WINDOW_MS + 6_000);
    gateway.failNextRefundExplicitly();

    const result = await app.applyPaymentResult(event);

    expect(result).toEqual({ ok: true, data: { paymentStatus: "succeeded", orderStatus: "expired" } });
    expect((await orderOf(alice, orderId)).refunds).toMatchObject([{ status: "failed", reason: "late_success_unreclaimable" }]);
    expect(gateway.refunded).toEqual([]);
  });

  it("付款設定不全（沒有閘道）：退不了款，退款留在 pending（沒有送出任何請求）並記 log，不丟例外", async () => {
    const { alice, orderId, variantId, event } = await lateSuccessSetup({ onHand: 3, quantity: 2 });
    const bob = await signInCustomer("bob");
    await placeOrderAt(bob, variantId, 2, T0 + PAYMENT_WINDOW_MS + 6_000);
    const errors = vi.spyOn(console, "error");
    const service = createPaymentService(env.DB, { now: () => Date.now() }, async () => null, null, "http://localhost:4321", noInvoices);

    const result = await service.applyPaymentResult(event);

    expect(result).toEqual({ ok: true, data: { paymentStatus: "succeeded", orderStatus: "expired" } });
    expect((await orderOf(alice, orderId)).refunds).toMatchObject([{ status: "pending", reason: "late_success_unreclaimable" }]);
    expect(loggedEvents(errors, "payment_refund_not_started")).toMatchObject([{ reason: "payment_unavailable" }]);
  });

  it("已取消的訂單收到付款成功：訂單維持已取消、在庫數不動，付款退款（cancelled_order）", async () => {
    const alice = await signInCustomer("alice");
    const { orderId, variantId } = await placeMugOrder(alice, { onHand: 10, quantity: 2 });
    const gateway = installFakeGateway();
    const gatewayPaymentId = await startPaymentFor(alice, orderId, gateway);
    // 取消與新付款的競態才會留下「已取消訂單上還有進行中的付款」，這裡直接安排
    await forceOrderStatus(orderId, "cancelled");

    const result = await app.applyPaymentResult(gateway.settle(gatewayPaymentId, "succeeded"));

    expect(result).toEqual({ ok: true, data: { paymentStatus: "succeeded", orderStatus: "cancelled" } });
    expect(await stockOf(variantId)).toEqual({ onHand: 10, available: 10 });
    const order = await orderOf(alice, orderId);
    expect(order.status).toBe("cancelled");
    expect(order.refunds).toMatchObject([{ status: "succeeded", reason: "cancelled_order" }]);
    expect(gateway.refunded).toEqual([gatewayPaymentId]);
  });

  it("同一訂單第二筆成功付款：已付款保留只有一份、可售只減一次，第二筆退款（duplicate_success），第一筆維持成功", async () => {
    const alice = await signInCustomer("alice");
    const { orderId, variantId, totalTwd } = await placeMugOrder(alice, { onHand: 10, quantity: 2 });
    const gateway = installFakeGateway();
    const first = await startPaymentFor(alice, orderId, gateway);
    // 發起新付款會先取消前一筆；「兩筆同時進行」只能直接安排
    const second = await seedPayment(orderId, "pending", "pay_second");
    gateway.adopt(second, { amountTwd: totalTwd, merchantReference: String(orderId) });

    await app.applyPaymentResult(gateway.settle(first, "succeeded"));
    const result = await app.applyPaymentResult(gateway.settle(second, "succeeded"));

    expect(result).toEqual({ ok: true, data: { paymentStatus: "succeeded", orderStatus: "paid" } });
    expect(await stockOf(variantId)).toEqual({ onHand: 10, available: 8 });
    const order = await orderOf(alice, orderId);
    expect(order.status).toBe("paid");
    expect(order.payments).toMatchObject([{ status: "succeeded" }, { status: "succeeded" }]);
    expect(order.refunds).toMatchObject([{ paymentId: order.payments[1]!.id, status: "succeeded", reason: "duplicate_success" }]);
    expect(gateway.refunded).toEqual([second]);
  });

  it("退款原因以 batch 當下的訂單狀態為準：batch 與退款之間訂單被別的動作轉走，原因不變", async () => {
    const { alice, orderId, variantId, event } = await lateSuccessSetup({ onHand: 3, quantity: 2 });
    const bob = await signInCustomer("bob");
    await placeOrderAt(bob, variantId, 2, T0 + PAYMENT_WINDOW_MS + 6_000);
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
      noInvoices,
    );

    await service.applyPaymentResult(event);

    expect((await orderOf(alice, orderId)).refunds).toMatchObject([{ status: "succeeded", reason: "late_success_unreclaimable" }]);
  });

  it("同一事件重送（含同時送達）：只退款一次，回同一結果", async () => {
    const { orderId, alice, variantId, gateway, event } = await lateSuccessSetup({ onHand: 3, quantity: 2 });
    const bob = await signInCustomer("bob");
    await placeOrderAt(bob, variantId, 2, T0 + PAYMENT_WINDOW_MS + 6_000);

    const first = await app.applyPaymentResult(event);
    const again = await app.applyPaymentResult(event);
    const concurrent = await Promise.all([1, 2, 3].map(() => app.applyPaymentResult(event)));

    expect(again).toEqual(first);
    for (const result of concurrent) expect(result).toEqual(first);
    expect(gateway.refundRequests).toHaveLength(1);
    expect((await orderOf(alice, orderId)).refunds).toMatchObject([{ status: "succeeded" }]);
  });
});

describe("遲到的付款成功與結帳搶最後一件：兩種先後各自的結果", () => {
  beforeEach(resetDb);
  afterEach(() => vi.restoreAllMocks());

  // 並行測試只驗不變量：實測時兩邊的先後並不平均（結帳要先驗 session，幾乎總是落後），不能靠它保證兩種結果都走過，所以各寫一個確定先後的測試。
  it("重新保留先到：訂單轉已付款、轉為已付款保留（在庫數不動），之後的結帳因可售數量不足被拒", async () => {
    const { alice, orderId, variantId, gateway, event } = await lateSuccessSetup({ onHand: 1, quantity: 1 });
    const bob = await signInCustomer("bob");

    await app.applyPaymentResult(event);
    const checkout = await app.checkout(bob, checkoutInput([{ variantId, quantity: 1, seenUnitPriceTwd: PRICE }]));

    expect(checkout).toMatchObject({ ok: false, reason: "checkout_rejected" });
    expect((await orderOf(alice, orderId)).status).toBe("paid");
    expect(await stockOf(variantId)).toEqual({ onHand: 1, available: 0 });
    expect(gateway.refunded).toEqual([]);
  });

  it("結帳先到：結帳成功保留了最後一件，之後的重新保留不到，付款退款（late_success_unreclaimable）", async () => {
    const { alice, orderId, variantId, gateway, event, gatewayPaymentId } = await lateSuccessSetup({ onHand: 1, quantity: 1 });
    const bob = await signInCustomer("bob");

    const checkout = await app.checkout(bob, checkoutInput([{ variantId, quantity: 1, seenUnitPriceTwd: PRICE }]));
    await app.applyPaymentResult(event);

    expect(checkout).toMatchObject({ ok: true });
    const order = await orderOf(alice, orderId);
    expect(order.status).toBe("expired");
    expect(order.refunds).toMatchObject([{ status: "succeeded", reason: "late_success_unreclaimable" }]);
    expect(await stockOf(variantId)).toEqual({ onHand: 1, available: 0 });
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
    const scenarios: { variantId: number; orderId: number; gatewayPaymentId: string }[] = [];
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
      noInvoices,
    );
    // 每個商品在庫 1，各有一張已逾期、付款成功事件還沒套用的訂單（不占保留，可售數量 1）
    for (let i = 0; i < rounds; i += 1) {
      // 商品/圖片上架由專屬測試涵蓋；此處只建 fixture，讓 60 秒預算用在 100 組真實付款/結帳 RPC 競爭。
      const created = await env.DB.prepare("INSERT INTO products (name, description) VALUES ('馬克杯', '說明') RETURNING id").first<{ id: number }>();
      if (!created) throw new Error("建立商品 fixture 失敗");
      const variant = await env.DB.prepare("INSERT INTO product_variants (product_id, is_default, price_twd, on_hand) VALUES (?, 1, ?, 1) RETURNING id")
        .bind(created.id, PRICE).first<{ id: number }>();
      if (!variant) throw new Error("建立變體 fixture 失敗");
      const variantId = variant.id;
      await seedImageAndList(created.id);
      setNow(T0 + i);
      const placed = await orderService.checkout("alice", checkoutInput([{ variantId, quantity: 1, seenUnitPriceTwd: PRICE }]));
      if (!placed.ok) throw new Error("結帳失敗");
      setNow(T0 + i + 500);
      const started = await setupPayments.startPayment("alice", { orderId: placed.data.orderId });
      if (!started.ok) throw new Error("發起付款失敗");
      scenarios.push({ variantId, orderId: placed.data.orderId, gatewayPaymentId: gateway.lastPaymentId() });
    }
    await runCron(T0 + rounds + PAYMENT_WINDOW_MS);
    const events = scenarios.map(({ gatewayPaymentId }) => gateway.settle(gatewayPaymentId, "succeeded"));
    setNow(T0 + rounds + PAYMENT_WINDOW_MS + 5_000);

    // 重新保留與結帳同時送出，兩邊的語句在 D1 上可能交錯（交錯與否不保證；改成 service 直呼時交錯變少，先讀後寫的變異抓不到）。
    // 不論怎麼交錯，下面的不變量都必須成立
    await Promise.all(
      scenarios.flatMap(({ variantId }, i) => [
        app.checkout(bob, checkoutInput([{ variantId, quantity: 1, seenUnitPriceTwd: PRICE }])),
        app.applyPaymentResult(events[i]),
      ]),
    );

    const bobListed = await app.listMyOrders(bob);
    const aliceListed = await app.listMyOrders(alice);
    const stocks = await app.listProductsForAdmin(await mintAccessJwt());
    if (!bobListed.ok || !aliceListed.ok || !stocks.ok) throw new Error("讀取失敗");
    const bobProducts = new Set(bobListed.data.flatMap((order) => order.lines.map((line) => line.variantId)));
    const alicePaid = new Set(aliceListed.data.filter((order) => order.status === "paid").map((order) => order.id));
    for (const { variantId, orderId, gatewayPaymentId } of scenarios) {
      const aliceHasIt = alicePaid.has(orderId);
      expect(aliceHasIt !== bobProducts.has(variantId), `商品 ${variantId} 應恰好一方拿到`).toBe(true);
      const stock = stocks.data.find((product) => product.id === variantId)!;
      expect(stock.available, `商品 ${variantId} 可售數量不可為負`).toBeGreaterThanOrEqual(0);
      // 付款不扣實體在庫（ADR 0006），那一件由已付款保留或 Bob 的待付款保留占用
      expect(stock.onHand).toBe(1);
      expect(stock.available).toBe(0);
      expect(gateway.refunded.includes(gatewayPaymentId)).toBe(!aliceHasIt);
    }
  }, 60_000);
});
