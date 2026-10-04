import { beforeEach, expect, it } from "vitest";
import { checkoutInput } from "./checkout-helpers";
import { setNow } from "./clock";
import { signInCustomer } from "./customers";
import { resetDb } from "./db";
import { installFakeGateway } from "./fake-gateway";
import { orderOf, startPaymentFor } from "./payment-helpers";
import { app, PRICE, placeOrderAt, runCron, stocked, stockOf } from "./release-helpers";

beforeEach(resetDb);

const T0 = Date.now() + 60_000;

/** A2 整合情境：兩位顧客依序競購最後一件，經過付款、逾期與遲到付款，每一步保留與實體都對得上事件表。 */
it("A2 兩顧客競購最後庫存：落敗者被拒、逾期釋出後換對方成立、遲到付款不能搶回而被退款，最後只有一張已付款訂單，不超賣", async () => {
  const alice = await signInCustomer("alice");
  const bob = await signInCustomer("bob");
  const variantId = await stocked(1);
  const gateway = installFakeGateway();

  // 愛麗絲先搶到最後一件：保留 1、可售 0、實體不動；鮑伯被拒
  const first = await placeOrderAt(alice, variantId, 1, T0);
  expect(await stockOf(variantId)).toEqual({ onHand: 1, available: 0 });
  setNow(T0 + 500);
  expect(await app.checkout(bob, checkoutInput([{ variantId, quantity: 1, seenUnitPriceTwd: PRICE }]))).toMatchObject({ ok: false, reason: "checkout_rejected", issues: [{ kind: "insufficient_stock" }] });
  expect(await stockOf(variantId)).toEqual({ onHand: 1, available: 0 });

  // 愛麗絲發起付款卻沒完成，期限過了逾期：保留釋出、實體不動
  setNow(T0 + 1_000);
  const gatewayPaymentId = await startPaymentFor(alice, first.orderId, gateway);
  await runCron(first.paymentDeadline);
  expect((await orderOf(alice, first.orderId)).status).toBe("expired");
  expect(await stockOf(variantId)).toEqual({ onHand: 1, available: 1 });

  // 鮑伯現在搶到
  setNow(first.paymentDeadline + 1_000);
  const second = await app.checkout(bob, checkoutInput([{ variantId, quantity: 1, seenUnitPriceTwd: PRICE }]));
  if (!second.ok) throw new Error("鮑伯結帳失敗");
  expect(await stockOf(variantId)).toEqual({ onHand: 1, available: 0 });

  // 愛麗絲的付款才到：重新保留不到，訂單維持已逾期、整筆退款，庫存不動
  setNow(first.paymentDeadline + 5_000);
  await app.applyPaymentResult(gateway.settle(gatewayPaymentId, "succeeded"));
  const late = await orderOf(alice, first.orderId);
  expect(late.status).toBe("expired");
  expect(late.refunds).toMatchObject([{ reason: "late_success_unreclaimable", amountTwd: first.totalTwd, status: "succeeded" }]);
  expect(gateway.refundedTwd(gatewayPaymentId)).toBe(first.totalTwd);
  expect(await stockOf(variantId)).toEqual({ onHand: 1, available: 0 });

  // 鮑伯付款：轉已付款保留，實體不動，沒有超賣
  const bobPayment = await startPaymentFor(bob, second.data.orderId, gateway);
  expect(await app.applyPaymentResult(gateway.settle(bobPayment, "succeeded"))).toMatchObject({ ok: true, data: { orderStatus: "paid" } });
  expect((await orderOf(bob, second.data.orderId)).status).toBe("paid");
  expect(await stockOf(variantId)).toEqual({ onHand: 1, available: 0 });
  expect(gateway.refundedTwd(bobPayment)).toBe(0);
});
