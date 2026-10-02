import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createOrderService } from "../src/orders/service";
import { systemClock } from "../src/shared/clock";
import { signInCustomer } from "./customers";
import { resetDb } from "./db";
import { app, PAYMENT_WINDOW_MS, placeOrderAt, runCron, statusOf, stockOf, stocked } from "./release-helpers";

const T0 = Date.now() + 60_000;

describe("顧客取消待付款訂單", () => {
  beforeEach(resetDb);

  it("取消成功：訂單轉為已取消，保留釋放，在庫數不變", async () => {
    const variantId = await stocked(10);
    const cookie = await signInCustomer("alice");
    const order = await placeOrderAt(cookie, variantId, 4, T0);
    expect(await stockOf(variantId)).toEqual({ onHand: 10, available: 6 });

    expect(await app.cancelOrder(cookie, { orderId: order.orderId })).toEqual({
      ok: true,
      data: { orderId: order.orderId, status: "cancelled" },
    });

    expect(await statusOf(cookie, order.orderId)).toBe("cancelled");
    expect(await stockOf(variantId)).toEqual({ onHand: 10, available: 10 });
  });

  it("取消別人的訂單：order_not_found，訂單不動；不存在的訂單同樣回 order_not_found", async () => {
    const variantId = await stocked(10);
    const alice = await signInCustomer("alice");
    const bob = await signInCustomer("bob");
    const order = await placeOrderAt(alice, variantId, 2, T0);

    expect(await app.cancelOrder(bob, { orderId: order.orderId })).toEqual({ ok: false, reason: "order_not_found" });
    expect(await app.cancelOrder(bob, { orderId: order.orderId + 1000 })).toEqual({ ok: false, reason: "order_not_found" });

    expect(await statusOf(alice, order.orderId)).toBe("pending_payment");
    expect(await stockOf(variantId)).toEqual({ onHand: 10, available: 8 });
  });

  it("取消已逾期或已取消的訂單：order_not_cancellable，狀態不變", async () => {
    const variantId = await stocked(10);
    const cookie = await signInCustomer("alice");
    const expired = await placeOrderAt(cookie, variantId, 1, T0);
    const cancelled = await placeOrderAt(cookie, variantId, 1, T0 + 1000);
    await app.cancelOrder(cookie, { orderId: cancelled.orderId });
    await runCron(T0 + PAYMENT_WINDOW_MS);

    expect(await app.cancelOrder(cookie, { orderId: expired.orderId })).toEqual({ ok: false, reason: "order_not_cancellable" });
    expect(await app.cancelOrder(cookie, { orderId: cancelled.orderId })).toEqual({ ok: false, reason: "order_not_cancellable" });

    expect(await statusOf(cookie, expired.orderId)).toBe("expired");
    expect(await statusOf(cookie, cancelled.orderId)).toBe("cancelled");
  });

  it("已取消是終點：之後 Cron 不會把它轉為已逾期", async () => {
    const variantId = await stocked(10);
    const cookie = await signInCustomer("alice");
    const order = await placeOrderAt(cookie, variantId, 1, T0);
    await app.cancelOrder(cookie, { orderId: order.orderId });

    await runCron(T0 + 2 * PAYMENT_WINDOW_MS);

    expect(await statusOf(cookie, order.orderId)).toBe("cancelled");
  });

  it("沒有 session 被拒絕為 unauthorized；訂單編號格式無效回 invalid_input", async () => {
    const cookie = await signInCustomer("alice");

    expect(await app.cancelOrder("", { orderId: 1 })).toEqual({ ok: false, reason: "unauthorized" });
    expect(await app.cancelOrder(cookie, { orderId: "abc" })).toMatchObject({ ok: false, reason: "invalid_input" });
  });
});

describe("Cron 與顧客取消並行", () => {
  beforeEach(resetDb);

  it("每張訂單最終只會是逾期或取消其中一種，取消回 ok 的必為已取消，保留只釋放一次", async () => {
    const variantId = await stocked(100);
    const cookie = await signInCustomer("alice");
    // 訂單越多，Cron 逐筆寫入的空窗越長，越容易讓先讀後寫的實作露餡
    const orders = [];
    for (let i = 0; i < 100; i += 1) orders.push(await placeOrderAt(cookie, variantId, 1, T0 + i));
    const at = T0 + PAYMENT_WINDOW_MS + 1000;

    // 取消走 service 並以固定身分取代 session 驗證：驗證的延遲會讓取消整批晚於 Cron，兩邊的語句就不會交錯。
    // Cron 與全部取消同時送出，語句在 D1 上可能交錯（交錯與否不保證）；不論怎麼交錯，下面的不變量都必須成立
    const { customer } = await app.getCustomerSession(cookie);
    const orderService = createOrderService(env.DB, systemClock, async () => customer!.customerId, async () => null);
    const [cancelResults] = await Promise.all([
      Promise.all(orders.map(({ orderId }) => orderService.cancelOrder(cookie, { orderId }))),
      runCron(at),
    ]);

    for (const [index, { orderId }] of orders.entries()) {
      const result = cancelResults[index]!;
      const status = await statusOf(cookie, orderId);
      expect(status).toBe(result.ok ? "cancelled" : "expired");
      if (!result.ok) expect(result.reason).toBe("order_not_cancellable");
    }
    expect(await stockOf(variantId)).toEqual({ onHand: 100, available: 100 });
  }, 30_000);

  it("付款期限當下 Cron 先跑：之後取消回 order_not_cancellable，訂單維持已逾期", async () => {
    const variantId = await stocked(10);
    const cookie = await signInCustomer("alice");
    const order = await placeOrderAt(cookie, variantId, 3, T0);

    await runCron(order.paymentDeadline);

    expect(await app.cancelOrder(cookie, { orderId: order.orderId })).toEqual({ ok: false, reason: "order_not_cancellable" });
    expect(await statusOf(cookie, order.orderId)).toBe("expired");
    expect(await stockOf(variantId)).toEqual({ onHand: 10, available: 10 });
  });
});
