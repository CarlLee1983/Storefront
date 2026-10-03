import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { commitRefund } from "../src/payments/refunds";
import { mintAccessJwt } from "./access";
import { resetDb } from "./db";
import { adminOrder } from "./shipment-helpers";
import { approveReturn, inspectReturn, receiveReturn, requestReturnOk, shippedMixedOrder, stockDetail } from "./return-helpers";

const app = exports.default;

beforeEach(resetDb);

async function receivedReturn(quantity: number) {
  const order = await shippedMixedOrder();
  const requestId = await requestReturnOk(order.cookie, order.orderId, [{ orderLineId: order.mugLine.id, quantity }]);
  await approveReturn(requestId);
  await receiveReturn(requestId, [{ orderLineId: order.mugLine.id, receivedQuantity: quantity }]);
  return { ...order, requestId, items: [{ orderLineId: order.mugLine.id, sellableQuantity: quantity, damagedQuantity: 0 }] };
}

const mailBody = async (cookie: string, kind: string) => {
  const mail = await app.listMyMail(cookie);
  const notice = mail.ok ? mail.data.find((message) => message.kind === kind) : undefined;
  const body = await app.getMyMail(cookie, { messageId: notice!.id });
  return body.ok ? body.data.body : "";
};

describe("退款失敗不反轉已發生的實物事件", () => {
  it("明確失敗：庫存已轉可售、退貨維持完成；退款留在待辦，原紀錄重試後成功並通知", async () => {
    const { cookie, orderId, gateway, mugVariantId, requestId, items } = await receivedReturn(2);
    const before = await stockDetail(mugVariantId);
    gateway.failNextRefundExplicitly();

    const inspected = await inspectReturn(requestId, items);

    expect(inspected).toMatchObject({ ok: true, data: { refund: { status: "failed" } } });
    expect(await stockDetail(mugVariantId)).toEqual({ ...before, unavailable: 0, available: before.available + 2 });
    const order = await adminOrder(orderId);
    expect(order.returns).toMatchObject([{ status: "completed", refund: { status: "failed" } }]);
    const todos = await app.listRefundsToHandle(await mintAccessJwt());
    const refundId = inspected.ok ? inspected.data.refund!.id : 0;
    expect(todos).toMatchObject({ ok: true, data: { refunds: [{ id: refundId, reason: "return", status: "failed" }] } });

    expect(await app.retryRefund(await mintAccessJwt(), { refundId })).toMatchObject({ ok: true, data: { status: "succeeded" } });
    expect((await adminOrder(orderId)).refunds).toHaveLength(1);
    const mail = await app.listMyMail(cookie);
    expect(mail.ok && mail.data.map((message) => message.kind)).toContain("refund_succeeded");
  });

  it("額度被其他退款占用：檢查結果照常成立、不登記退款，列進退款待辦且通知不承諾自動退款；額度釋出後重送檢查才登記", async () => {
    const { cookie, orderId, totalTwd, requestId, items } = await receivedReturn(1);
    const payment = (await env.DB.prepare("SELECT id FROM payments WHERE order_id = ?").bind(orderId).first<{ id: number }>())!;
    expect(await commitRefund(env.DB, { paymentId: payment.id, reason: "cancelled_order", amountTwd: totalTwd - 100, goodsTwd: totalTwd - 100, shippingTwd: 0 }, Date.now())).not.toBeNull();

    const inspected = await inspectReturn(requestId, items);

    expect(inspected).toMatchObject({ ok: true, data: { replayed: false, refund: null } });
    expect((await adminOrder(orderId)).returns).toMatchObject([{ status: "completed", goodsTwd: 320, refund: null }]);
    expect(await app.listRefundsToHandle(await mintAccessJwt())).toMatchObject({ ok: true, data: { unregisteredReturns: [{ id: requestId, orderId, goodsTwd: 320 }] } });
    expect(await mailBody(cookie, "return_completed")).toContain("客服會與你聯繫");

    await env.DB.prepare("DELETE FROM refunds WHERE reason = 'cancelled_order'").run();
    expect(await inspectReturn(requestId, items)).toMatchObject({ ok: true, data: { replayed: true, refund: { status: "succeeded" } } });
    expect(await app.listRefundsToHandle(await mintAccessJwt())).toMatchObject({ ok: true, data: { unregisteredReturns: [] } });
  });

  it("結果不明的前筆阻擋後筆：退貨的退款與其他退款同單逐筆，查證後才能執行", async () => {
    const { orderId, gateway, requestId, items } = await receivedReturn(1);
    gateway.loseNextRefundResponse();

    const inspected = await inspectReturn(requestId, items);

    expect(inspected).toMatchObject({ ok: true, data: { refund: { status: "unknown" } } });
    expect((await adminOrder(orderId)).returns).toMatchObject([{ status: "completed" }]);
    const refundId = inspected.ok ? inspected.data.refund!.id : 0;
    expect(await app.retryRefund(await mintAccessJwt(), { refundId })).toMatchObject({ ok: true, data: { status: "succeeded" } });
    expect(gateway.refundRequests).toHaveLength(1);
  });

  it("退款額不超過實收：全部退完（含兩類運費）合計等於實收", async () => {
    const { orderId, totalTwd, mugLine, tableLine, cookie } = await shippedMixedOrder();
    for (const [line, quantity] of [[mugLine, 3], [tableLine, 1]] as const) {
      const requestId = await requestReturnOk(cookie, orderId, [{ orderLineId: line.id, quantity }]);
      await approveReturn(requestId);
      await receiveReturn(requestId, [{ orderLineId: line.id, receivedQuantity: quantity }]);
      await inspectReturn(requestId, [{ orderLineId: line.id, sellableQuantity: 0, damagedQuantity: quantity }]);
    }

    const refunds = (await adminOrder(orderId)).refunds;
    expect(refunds.reduce((sum, refund) => sum + refund.amountTwd, 0)).toBe(totalTwd);
    expect(refunds.every((refund) => refund.status === "succeeded")).toBe(true);
  });
});
