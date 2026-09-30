import { beforeEach, describe, expect, it } from "vitest";
import { signInCustomer } from "./customers";
import { resetDb } from "./db";
import { app, PAYMENT_WINDOW_MS, placeOrderAt, runCron, statusOf, stockOf, stocked } from "./release-helpers";

const T0 = Date.now() + 60_000;

describe("顧客取消待付款訂單", () => {
  beforeEach(resetDb);

  it("取消成功：訂單轉為已取消，保留釋放，在庫數不變", async () => {
    const productId = await stocked(10);
    const cookie = await signInCustomer("alice");
    const order = await placeOrderAt(cookie, productId, 4, T0);
    expect(await stockOf(productId)).toEqual({ onHand: 10, available: 6 });

    expect(await app.cancelOrder(cookie, { orderId: order.orderId })).toEqual({
      ok: true,
      data: { orderId: order.orderId, status: "cancelled" },
    });

    expect(await statusOf(cookie, order.orderId)).toBe("cancelled");
    expect(await stockOf(productId)).toEqual({ onHand: 10, available: 10 });
  });

  it("取消別人的訂單：order_not_found，訂單不動；不存在的訂單同樣回 order_not_found", async () => {
    const productId = await stocked(10);
    const alice = await signInCustomer("alice");
    const bob = await signInCustomer("bob");
    const order = await placeOrderAt(alice, productId, 2, T0);

    expect(await app.cancelOrder(bob, { orderId: order.orderId })).toEqual({ ok: false, reason: "order_not_found" });
    expect(await app.cancelOrder(bob, { orderId: order.orderId + 1000 })).toEqual({ ok: false, reason: "order_not_found" });

    expect(await statusOf(alice, order.orderId)).toBe("pending_payment");
    expect(await stockOf(productId)).toEqual({ onHand: 10, available: 8 });
  });

  it("取消已逾期或已取消的訂單：order_not_cancellable，狀態不變", async () => {
    const productId = await stocked(10);
    const cookie = await signInCustomer("alice");
    const expired = await placeOrderAt(cookie, productId, 1, T0);
    const cancelled = await placeOrderAt(cookie, productId, 1, T0 + 1000);
    await app.cancelOrder(cookie, { orderId: cancelled.orderId });
    await runCron(T0 + PAYMENT_WINDOW_MS);

    expect(await app.cancelOrder(cookie, { orderId: expired.orderId })).toEqual({ ok: false, reason: "order_not_cancellable" });
    expect(await app.cancelOrder(cookie, { orderId: cancelled.orderId })).toEqual({ ok: false, reason: "order_not_cancellable" });

    expect(await statusOf(cookie, expired.orderId)).toBe("expired");
    expect(await statusOf(cookie, cancelled.orderId)).toBe("cancelled");
  });

  it("已取消是終點：之後 Cron 不會把它轉為已逾期", async () => {
    const productId = await stocked(10);
    const cookie = await signInCustomer("alice");
    const order = await placeOrderAt(cookie, productId, 1, T0);
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
    const productId = await stocked(100);
    const cookie = await signInCustomer("alice");
    const orders = [];
    for (let i = 0; i < 12; i += 1) orders.push(await placeOrderAt(cookie, productId, 1, T0 + i));
    const at = T0 + PAYMENT_WINDOW_MS + 1000;

    // 取消依序進行，與 Cron 逐筆處理交錯：讓「Cron 讀到清單之後、寫入之前訂單被取消」這種時序真的發生
    const cancelling = (async () => {
      const results = [];
      for (const { orderId } of orders) results.push(await app.cancelOrder(cookie, { orderId }));
      return results;
    })();
    const [, cancelResults] = await Promise.all([runCron(at), cancelling]);

    for (const [index, { orderId }] of orders.entries()) {
      const result = cancelResults[index]!;
      const status = await statusOf(cookie, orderId);
      expect(status).toBe(result.ok ? "cancelled" : "expired");
      if (!result.ok) expect(result.reason).toBe("order_not_cancellable");
    }
    expect(await stockOf(productId)).toEqual({ onHand: 100, available: 100 });
  });

  it("確定性交錯：Cron 讀到逾期資料之後、寫入之前顧客取消，訂單仍只會是一種狀態", async () => {
    const productId = await stocked(10);
    const cookie = await signInCustomer("alice");
    const order = await placeOrderAt(cookie, productId, 3, T0);
    let cancelled: Awaited<ReturnType<typeof app.cancelOrder>> | undefined;

    await runCron(order.paymentDeadline, async () => {
      cancelled ??= await app.cancelOrder(cookie, { orderId: order.orderId });
    });

    const status = await statusOf(cookie, order.orderId);
    expect(status).toBe(cancelled?.ok ? "cancelled" : "expired");
    expect(await stockOf(productId)).toEqual({ onHand: 10, available: 10 });
  });
});
