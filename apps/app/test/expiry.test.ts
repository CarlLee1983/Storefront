import { beforeEach, describe, expect, it, vi } from "vitest";
import { signInCustomer } from "./customers";
import { resetDb } from "./db";
import { PAYMENT_WINDOW_MS, placeOrderAt, runCron, statusOf, stockOf, stocked } from "./release-helpers";

// 起點貼近真實時間：顧客 session 以真實時間簽發，時間跳太遠會讓 session 過期
const T0 = Date.now() + 60_000;

describe("Cron：付款期限過後把待付款訂單轉為已逾期", () => {
  beforeEach(resetDb);

  it("付款期限前不動；過了付款期限轉為已逾期，可售數量恢復、在庫數不變", async () => {
    const variantId = await stocked(10);
    const cookie = await signInCustomer("alice");
    const order = await placeOrderAt(cookie, variantId, 4, T0);
    expect(order.paymentDeadline).toBe(T0 + PAYMENT_WINDOW_MS);

    await runCron(T0 + PAYMENT_WINDOW_MS - 1);
    expect(await statusOf(cookie, order.orderId)).toBe("pending_payment");
    expect(await stockOf(variantId)).toEqual({ onHand: 10, available: 6 });

    await runCron(T0 + PAYMENT_WINDOW_MS + 1);
    expect(await statusOf(cookie, order.orderId)).toBe("expired");
    expect(await stockOf(variantId)).toEqual({ onHand: 10, available: 10 });
  });

  it("邊界：剛好等於付款期限就逾期", async () => {
    const variantId = await stocked(10);
    const cookie = await signInCustomer("alice");
    const order = await placeOrderAt(cookie, variantId, 1, T0);

    await runCron(order.paymentDeadline);

    expect(await statusOf(cookie, order.orderId)).toBe("expired");
  });

  it("只影響待付款訂單：尚未到期的訂單不動，並記一行結構化 log 帶轉換筆數", async () => {
    const variantId = await stocked(10);
    const cookie = await signInCustomer("alice");
    const old = await placeOrderAt(cookie, variantId, 1, T0);
    const fresh = await placeOrderAt(cookie, variantId, 2, T0 + 10 * 60_000);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await runCron(T0 + PAYMENT_WINDOW_MS);

    expect(await statusOf(cookie, old.orderId)).toBe("expired");
    expect(await statusOf(cookie, fresh.orderId)).toBe("pending_payment");
    expect(await stockOf(variantId)).toEqual({ onHand: 10, available: 8 });
    expect(log).toHaveBeenCalledWith(JSON.stringify({ event: "orders_expired", count: 1 }));
    log.mockRestore();
  });

  it("重跑與同時跑兩次結果一致", async () => {
    const variantId = await stocked(10);
    const cookie = await signInCustomer("alice");
    const orders = [await placeOrderAt(cookie, variantId, 1, T0), await placeOrderAt(cookie, variantId, 2, T0 + 1000)];
    const at = T0 + 2 * PAYMENT_WINDOW_MS;

    await Promise.all([runCron(at), runCron(at)]);
    await runCron(at);

    for (const { orderId } of orders) expect(await statusOf(cookie, orderId)).toBe("expired");
    expect(await stockOf(variantId)).toEqual({ onHand: 10, available: 10 });
  });
});
