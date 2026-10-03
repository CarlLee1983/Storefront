import { exports } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import { mintAccessJwt } from "./access";
import { approveOk, paidMixedOrder, requestCancelOk } from "./cancellation-helpers";
import { setNow } from "./clock";
import { resetDb } from "./db";
import { confirmLossOk, shipItems } from "./loss-helpers";
import { approveReturn, inspectReturn, receiveReturn, requestReturn, requestReturnOk } from "./return-helpers";
import { adminOrder, adminShipment, reportShipmentEvent } from "./shipment-helpers";

const app = exports.default;
const MINUTE = 60_000;

beforeEach(resetDb);

const retry = async (refundId: number) => app.retryRefund(await mintAccessJwt(), { refundId });

/** A8 整合情境：同一張訂單三筆不同來源的退款（遺失、取消、退貨）撞在一起，前一筆結果不明，並在途中重送、亂序回呼與並行重試。 */
it("A8 結果不明的前筆先查再放行後筆，並行重試與重複、亂序的付款回呼不重退、不超過實收與數量上限", async () => {
  const { cookie, orderId, gateway, mugLine, tableLine, totalTwd } = await paidMixedOrder();
  const gatewayPaymentId = [...gateway.payments.keys()][0]!;
  const mugA = await shipItems(orderId, [{ orderLineId: mugLine.id, quantity: 2 }]);
  const table = await shipItems(orderId, [{ orderLineId: tableLine.id, quantity: 1 }], true);
  const { shippedAt } = await adminShipment(orderId, mugA);
  setNow(shippedAt! + 180 * MINUTE);
  expect(await reportShipmentEvent(mugA, "evt-a", "delivered", shippedAt! + 60 * MINUTE)).toMatchObject({ ok: true });

  // 前筆（遺失）：閘道已退、回應遺失，結果不明
  gateway.loseNextRefundResponse();
  await confirmLossOk(table, [{ orderLineId: tableLine.id, quantity: 1 }]);
  // 後兩筆（取消、退貨）：核准與檢查照常成立，退款留在待處理
  await approveOk(await requestCancelOk(cookie, orderId, [{ orderLineId: mugLine.id, quantity: 1 }]));
  const returnId = await requestReturnOk(cookie, orderId, [{ orderLineId: mugLine.id, quantity: 1 }]);
  await approveReturn(returnId);
  await receiveReturn(returnId, [{ orderLineId: mugLine.id, receivedQuantity: 1 }]);
  await inspectReturn(returnId, [{ orderLineId: mugLine.id, sellableQuantity: 1, damagedQuantity: 0 }]);

  const [loss, cancellation, returned] = (await adminOrder(orderId)).refunds;
  expect([loss!.status, cancellation!.status, returned!.status]).toEqual(["unknown", "pending", "pending"]);
  expect(gateway.refundRequests).toHaveLength(1);
  expect(await retry(cancellation!.id)).toEqual({ ok: false, reason: "refund_blocked" });
  expect(await retry(returned!.id)).toEqual({ ok: false, reason: "refund_blocked" });

  // 重複與亂序的付款回呼：成功事件重送、成功之後才到的失敗事件，都不改訂單與退款
  const before = await adminOrder(orderId);
  await Promise.all([1, 2, 3].map(() => app.applyPaymentResult(gateway.settle(gatewayPaymentId, "succeeded"))));
  await app.applyPaymentResult({ eventId: "evt_stray_failed", gatewayPaymentId, outcome: "failed" });
  const afterCallbacks = await adminOrder(orderId);
  expect(afterCallbacks.status).toBe(before.status);
  expect(afterCallbacks.refunds.map((refund) => [refund.id, refund.status])).toEqual(before.refunds.map((refund) => [refund.id, refund.status]));
  expect(gateway.refundRequests).toHaveLength(1);

  // 並行重試三筆：不明的先查證成功；後兩筆不超前（被擋或在它之後成功），閘道上每筆最多一次成功退款
  await Promise.all([retry(loss!.id), retry(loss!.id), retry(cancellation!.id), retry(returned!.id)]);
  await retry(cancellation!.id);
  await retry(returned!.id);

  const final = await adminOrder(orderId);
  expect(final.refunds.map((refund) => [refund.amountTwd, refund.status])).toEqual([[6600, "succeeded"], [320, "succeeded"], [320, "succeeded"]]);
  expect(gateway.refundRequests.map((request) => request.amountTwd).sort((a, b) => a - b)).toEqual([320, 320, 6600]);
  expect(new Set(gateway.refundRequests.map((request) => request.refundId)).size).toBe(3);
  expect(gateway.refundedTwd(gatewayPaymentId)).toBe(7240);
  expect(7240).toBeLessThanOrEqual(totalTwd);
  expect(final.timeline.progress.money).toMatchObject({ paidTwd: totalTwd, refundedTwd: 7240, refundOpenTwd: 0 });

  // 數量上限：只剩 1 件馬克杯（其餘 1 件取消、1 件退回），再退 2 件被擋，不產生新退款
  expect(await requestReturn(cookie, orderId, [{ orderLineId: mugLine.id, quantity: 2 }])).toEqual({ ok: false, reason: "return_quantity_exceeded" });
  expect((await adminOrder(orderId)).refunds).toHaveLength(3);
});
