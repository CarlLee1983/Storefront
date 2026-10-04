import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { commitRefund } from "../src/payments/refunds";
import { mintAccessJwt } from "./access";
import { approveOk, paidMixedOrder, requestCancelOk } from "./cancellation-helpers";
import { setNow } from "./clock";
import { signInCustomer } from "./customers";
import { resetDb } from "./db";
import { confirmLoss, confirmLossOk, shipItems } from "./loss-helpers";
import { approveReturn, inspectReturn, receiveReturn, requestReturn, requestReturnOk, stockDetail } from "./return-helpers";
import { adminOrder, adminShipment, reportShipmentEvent } from "./shipment-helpers";

const app = exports.default;

beforeEach(resetDb);

const MINUTE = 60_000;
const refundsOf = async (orderId: number) => (await adminOrder(orderId)).refunds;
const splitOf = (refunds: Awaited<ReturnType<typeof refundsOf>>) => refunds.map((refund) => [refund.reason, refund.goodsTwd, refund.shippingTwd]);
const mailOf = async (cookie: string) => {
  const mail = await app.listMyMail(cookie);
  if (!mail.ok) throw new Error("讀信失敗");
  return mail.data;
};
const bodyOf = async (cookie: string, kind: string) => {
  const notice = (await mailOf(cookie)).find((message) => message.kind === kind);
  const body = await app.getMyMail(cookie, { messageId: notice!.id });
  return body.ok ? body.data.body : "";
};

/** 馬克杯 3 件分兩批（2 + 1）、餐桌 1 件一批，全部交運；回傳訂單與三個批次。 */
async function shippedInBatches() {
  const order = await paidMixedOrder();
  const mugA = await shipItems(order.orderId, [{ orderLineId: order.mugLine.id, quantity: 2 }]);
  const mugB = await shipItems(order.orderId, [{ orderLineId: order.mugLine.id, quantity: 1 }]);
  const table = await shipItems(order.orderId, [{ orderLineId: order.tableLine.id, quantity: 1 }], true);
  return { ...order, mugA, mugB, table };
}

/** 物流回報一筆事件：發生在交運後 `minutes` 分鐘，並把「現在」推到那之後。 */
async function reportAfter(orderId: number, shipmentId: number, eventKey: string, kind: "delivered" | "delivery_failed" | "redelivery", minutes = 60) {
  const { shippedAt } = await adminShipment(orderId, shipmentId);
  setNow(shippedAt! + minutes * MINUTE * 2);
  return reportShipmentEvent(shipmentId, eventKey, kind, shippedAt! + minutes * MINUTE);
}

describe("確認遺失：退款與庫存", () => {
  it("大型配送遺失：退商品款加該類原運費、不回補庫存也不寫流水，批次成為遺失，顧客收到通知並看得到退款", async () => {
    const { cookie, orderId, tableVariantId, tableLine, table } = await shippedInBatches();
    const before = await stockDetail(tableVariantId);
    const movements = (await env.DB.prepare("SELECT COUNT(*) AS n FROM stock_movements").first<{ n: number }>())!.n;

    const confirmed = await confirmLossOk(table, [{ orderLineId: tableLine.id, quantity: 1 }]);

    expect(confirmed).toMatchObject({ replayed: false, refund: { status: "succeeded" } });
    expect(await stockDetail(tableVariantId)).toEqual(before);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM stock_movements").first<{ n: number }>())!.n).toBe(movements);
    const order = await adminOrder(orderId);
    expect(order.refunds).toMatchObject([{ reason: "loss", amountTwd: 6600, goodsTwd: 6000, shippingTwd: 600, status: "succeeded" }]);
    expect(order.losses).toMatchObject([{ shipmentId: table, goodsTwd: 6000, shippingTwd: 600, actor: "admin@example.com", items: [{ orderLineId: tableLine.id, quantity: 1, amountTwd: 6000 }], refund: { amountTwd: 6600 } }]);
    expect(order.shipments.find((shipment) => shipment.id === table)).toMatchObject({ deliveryStatus: "lost" });
    expect(order.lines.find((line) => line.id === tableLine.id)).toMatchObject({ lostQuantity: 1 });
    expect(await app.getMyOrder(cookie, { orderId })).toMatchObject({ ok: true, data: { losses: [{ goodsTwd: 6000, shippingTwd: 600, refund: { amountTwd: 6600 } }] } });
    expect((await mailOf(cookie)).map((message) => message.kind)).toEqual(expect.arrayContaining(["shipment_loss_confirmed", "refund_succeeded"]));
    const body = await bodyOf(cookie, "shipment_loss_confirmed");
    expect(body).toContain("重新下單");
    expect(body).toContain("退款完成會另行通知");
  });

  it("任一該類遺失就退該類原運費一次，即使同類其他批已送達", async () => {
    const { orderId, mugLine, mugA, mugB } = await shippedInBatches();
    expect(await reportAfter(orderId, mugA, "ev-a", "delivered")).toMatchObject({ ok: true });

    await confirmLossOk(mugB, [{ orderLineId: mugLine.id, quantity: 1 }]);

    expect(await refundsOf(orderId)).toMatchObject([{ reason: "loss", amountTwd: 420, goodsTwd: 320, shippingTwd: 100 }]);
  });

  it("同類第二案遺失只退商品款（運費已退過）", async () => {
    const { orderId, mugLine, mugA, mugB } = await shippedInBatches();

    await confirmLossOk(mugB, [{ orderLineId: mugLine.id, quantity: 1 }]);
    await confirmLossOk(mugA, [{ orderLineId: mugLine.id, quantity: 2 }]);

    expect(splitOf(await refundsOf(orderId))).toEqual([["loss", 320, 100], ["loss", 640, 0]]);
  });

  it("商品款按原實付單價（改價不影響），只退受影響數量", async () => {
    const { orderId, mugLine, mugVariantId, mugA } = await shippedInBatches();
    await env.DB.prepare("UPDATE product_variants SET price_twd = 999 WHERE id = ?").bind(mugVariantId).run();

    await confirmLossOk(mugA, [{ orderLineId: mugLine.id, quantity: 1 }]);

    expect(splitOf(await refundsOf(orderId))).toEqual([["loss", 320, 100]]);
  });
});

describe("確認遺失：與物流回報的先後", () => {
  it("暫時配送失敗不是遺失：失敗與再次配送都不產生遺失或退款，之後送達就不能再確認遺失", async () => {
    const { orderId, tableLine, table } = await shippedInBatches();
    await reportAfter(orderId, table, "ev-1", "delivery_failed", 30);
    expect((await adminOrder(orderId)).shipments.find((shipment) => shipment.id === table)).toMatchObject({ deliveryStatus: "delivery_failed" });
    expect((await adminOrder(orderId)).losses).toEqual([]);
    expect(await refundsOf(orderId)).toEqual([]);

    expect(await reportAfter(orderId, table, "ev-2", "delivered", 60)).toMatchObject({ ok: true, data: { deliveryStatus: "delivered" } });
    expect(await confirmLoss(table, [{ orderLineId: tableLine.id, quantity: 1 }])).toEqual({ ok: false, reason: "shipment_delivered" });
  });

  it("配送失敗中的批次可以確認遺失；確認之後才到的送達、失敗、再次配送回報只留紀錄，不改進度、不寄送達通知", async () => {
    const { cookie, orderId, tableLine, table } = await shippedInBatches();
    await reportAfter(orderId, table, "ev-1", "delivery_failed", 30);
    await confirmLossOk(table, [{ orderLineId: tableLine.id, quantity: 1 }]);

    const late = await reportAfter(orderId, table, "ev-late", "delivered", 90);

    expect(late).toMatchObject({ ok: true, data: { deliveryStatus: "lost" } });
    expect(await reportAfter(orderId, table, "ev-late-2", "redelivery", 120)).toMatchObject({ ok: true, data: { deliveryStatus: "lost" } });
    expect(await reportAfter(orderId, table, "ev-late-3", "delivery_failed", 150)).toMatchObject({ ok: true, data: { deliveryStatus: "lost" } });
    const shipment = await adminShipment(orderId, table);
    expect(shipment.events.map((event) => [event.eventKey, event.noticeExpected])).toEqual([["ev-1", false], ["ev-late", false], ["ev-late-2", false], ["ev-late-3", false]]);
    const kinds = (await mailOf(cookie)).map((message) => message.kind);
    expect(kinds).not.toContain("shipment_delivered");
    // 遺失前的那一次失敗回報有寄通知，遺失後才到的失敗回報不再寄
    expect(kinds.filter((kind) => kind === "shipment_delivery_failed")).toHaveLength(1);
    // 款項與遺失紀錄不因晚到的回報改變
    expect((await adminOrder(orderId)).losses).toHaveLength(1);
    expect(await refundsOf(orderId)).toHaveLength(1);
  });

  it("遺失後才送達的批次：遺失的數量不能自助退貨，只剩未遺失的數量可退", async () => {
    const { cookie, orderId, mugLine, mugA } = await shippedInBatches();
    await confirmLossOk(mugA, [{ orderLineId: mugLine.id, quantity: 1 }]);
    await reportAfter(orderId, mugA, "ev-late", "delivered", 30);

    const mine = await app.getMyOrder(cookie, { orderId });

    expect(mine).toMatchObject({ ok: true, data: { returnBatches: expect.arrayContaining([{ shipmentId: mugA, state: "open", deliveredAt: expect.any(Number), windowEndsAt: expect.any(Number), items: [expect.objectContaining({ quantity: 2, selfServiceQuantity: 1 })] }]) } });
    expect(await requestReturn(cookie, orderId, [{ orderLineId: mugLine.id, shipmentId: mugA, quantity: 2 }])).toEqual({ ok: false, reason: "return_quantity_exceeded" });
    expect(await requestReturn(cookie, orderId, [{ orderLineId: mugLine.id, shipmentId: mugA, quantity: 1 }])).toMatchObject({ ok: true });
  });

  it("部分遺失之後才送達：批次仍是遺失但已送達，不能再確認遺失；送達通知照寄、只列未遺失的數量，送達回報應有通知", async () => {
    const { cookie, orderId, mugLine, mugA } = await shippedInBatches();
    await confirmLossOk(mugA, [{ orderLineId: mugLine.id, quantity: 1 }]);
    await reportAfter(orderId, mugA, "ev-late", "delivered", 30);

    expect(await confirmLoss(mugA, [{ orderLineId: mugLine.id, quantity: 1 }])).toEqual({ ok: false, reason: "shipment_delivered" });

    const shipment = await adminShipment(orderId, mugA);
    expect(shipment).toMatchObject({ deliveryStatus: "lost", deliveredAt: expect.any(Number) });
    expect(shipment.events).toMatchObject([{ eventKey: "ev-late", noticeExpected: true, noticeMessageId: expect.any(Number) }]);
    const body = await bodyOf(cookie, "shipment_delivered");
    expect(body).toContain("× 1");
    expect(body).not.toContain("× 2");
    expect(body).toContain("7 天內可在訂單頁自助申請退貨");
    expect((await adminOrder(orderId)).losses).toHaveLength(1);
  });

  it("顧客看到的遺失不含管理員備註與確認人，管理員看得到", async () => {
    const { cookie, orderId, mugLine, mugA } = await shippedInBatches();
    await confirmLossOk(mugA, [{ orderLineId: mugLine.id, quantity: 1 }]).then(() => confirmLoss(mugA, [{ orderLineId: mugLine.id, quantity: 1 }], { note: "內部查證" }));

    const mine = await app.getMyOrder(cookie, { orderId });
    expect(mine.ok && mine.data.losses.every((loss) => !("note" in loss) && !("actor" in loss))).toBe(true);
    expect((await adminOrder(orderId)).losses).toMatchObject([{}, { note: "內部查證" }]);
  });

  it("不存在的批次回 shipment_not_found，不留下遺失", async () => {
    const { orderId, tableLine } = await shippedInBatches();

    expect(await confirmLoss(999999, [{ orderLineId: tableLine.id, quantity: 1 }])).toEqual({ ok: false, reason: "shipment_not_found" });
    expect((await adminOrder(orderId)).losses).toEqual([]);
  });
});

describe("確認遺失：數量與退貨互斥", () => {
  it("明細不在這一批、超過該批數量、已遺失的數量都被擋下", async () => {
    const { mugLine, tableLine, mugA, mugB } = await shippedInBatches();

    expect(await confirmLoss(mugA, [{ orderLineId: tableLine.id, quantity: 1 }])).toEqual({ ok: false, reason: "loss_line_invalid" });
    expect(await confirmLoss(mugB, [{ orderLineId: mugLine.id, quantity: 2 }])).toEqual({ ok: false, reason: "loss_quantity_exceeded" });
    await confirmLossOk(mugB, [{ orderLineId: mugLine.id, quantity: 1 }]);
    expect(await confirmLoss(mugB, [{ orderLineId: mugLine.id, quantity: 1 }])).toEqual({ ok: false, reason: "loss_quantity_exceeded" });
  });

  it("遺失的數量不可再被退貨申請占用，反之被退貨占用的數量也不可遺失；退貨拒絕釋出後又可遺失", async () => {
    const { cookie, orderId, mugLine, mugA, mugB } = await shippedInBatches();
    await confirmLossOk(mugB, [{ orderLineId: mugLine.id, quantity: 1 }]);

    // 已交運 3、遺失 1：只剩 2 可退貨
    expect(await requestReturn(cookie, orderId, [{ orderLineId: mugLine.id, quantity: 3 }])).toEqual({ ok: false, reason: "return_quantity_exceeded" });
    const requestId = await requestReturnOk(cookie, orderId, [{ orderLineId: mugLine.id, quantity: 2 }]);
    expect(await confirmLoss(mugA, [{ orderLineId: mugLine.id, quantity: 1 }])).toEqual({ ok: false, reason: "loss_quantity_exceeded" });

    expect(await app.decideReturn(await mintAccessJwt(), { requestId, decision: "reject" })).toMatchObject({ ok: true });
    expect(await confirmLoss(mugA, [{ orderLineId: mugLine.id, quantity: 2 }])).toMatchObject({ ok: true });
  });

  it("遺失與退貨申請同時搶最後的數量，只有一邊成立", async () => {
    const { cookie, orderId, mugLine, mugA } = await shippedInBatches();

    const [returned, lost] = await Promise.all([
      requestReturn(cookie, orderId, [{ orderLineId: mugLine.id, quantity: 3 }]),
      confirmLoss(mugA, [{ orderLineId: mugLine.id, quantity: 2 }]),
    ]);

    expect([returned.ok, lost.ok].filter(Boolean)).toHaveLength(1);
    const order = await adminOrder(orderId);
    expect(order.returns.length + order.losses.length).toBe(1);
  });
});

describe("確認遺失：與取消、退貨的運費互斥，不雙退", () => {
  it("取消在先（不符全退出、不退運費），之後遺失才退一次運費，合計不超過實付", async () => {
    const { cookie, orderId, mugLine } = await paidMixedOrder();
    const mugBatch = await shipItems(orderId, [{ orderLineId: mugLine.id, quantity: 1 }]);
    await approveOk(await requestCancelOk(cookie, orderId, [{ orderLineId: mugLine.id, quantity: 2 }]));

    await confirmLossOk(mugBatch, [{ orderLineId: mugLine.id, quantity: 1 }]);

    const refunds = await refundsOf(orderId);
    expect(splitOf(refunds)).toEqual([["cancellation", 640, 0], ["loss", 320, 100]]);
    expect(refunds.reduce((sum, refund) => sum + refund.amountTwd, 0)).toBe(3 * 320 + 100);
  });

  it("遺失在先退運費，之後取消其餘數量即使同類全退出也不再退運費", async () => {
    const { cookie, orderId, mugLine } = await paidMixedOrder();
    const mugBatch = await shipItems(orderId, [{ orderLineId: mugLine.id, quantity: 1 }]);
    await confirmLossOk(mugBatch, [{ orderLineId: mugLine.id, quantity: 1 }]);

    await approveOk(await requestCancelOk(cookie, orderId, [{ orderLineId: mugLine.id, quantity: 2 }]));

    expect(splitOf(await refundsOf(orderId))).toEqual([["loss", 320, 100], ["cancellation", 640, 0]]);
  });

  it("退貨先申請、遺失後完成：運費只退遺失那一次，退貨不再退", async () => {
    const { cookie, orderId, mugLine, mugB } = await shippedInBatches();
    const requestId = await requestReturnOk(cookie, orderId, [{ orderLineId: mugLine.id, quantity: 2 }]);
    await approveReturn(requestId);
    await confirmLossOk(mugB, [{ orderLineId: mugLine.id, quantity: 1 }]);
    await receiveReturn(requestId, [{ orderLineId: mugLine.id, receivedQuantity: 2 }]);

    const inspected = await inspectReturn(requestId, [{ orderLineId: mugLine.id, sellableQuantity: 2, damagedQuantity: 0 }]);

    expect(inspected).toMatchObject({ ok: true, data: { refund: { status: "succeeded" } } });
    expect(splitOf(await refundsOf(orderId))).toEqual([["loss", 320, 100], ["return", 640, 0]]);
  });

  it("遺失在先、之後退貨完成：同類即使全退出（含遺失）也不再退運費", async () => {
    const { cookie, orderId, mugLine, mugB } = await shippedInBatches();
    await confirmLossOk(mugB, [{ orderLineId: mugLine.id, quantity: 1 }]);
    const requestId = await requestReturnOk(cookie, orderId, [{ orderLineId: mugLine.id, quantity: 2 }]);
    await approveReturn(requestId);
    await receiveReturn(requestId, [{ orderLineId: mugLine.id, receivedQuantity: 2 }]);

    await inspectReturn(requestId, [{ orderLineId: mugLine.id, sellableQuantity: 2, damagedQuantity: 0 }]);

    expect(splitOf(await refundsOf(orderId))).toEqual([["loss", 320, 100], ["return", 640, 0]]);
  });

  it("退貨完成在先已退該類運費（全退出），遺失另一類只退另一類的運費", async () => {
    const { cookie, orderId, mugLine, tableLine, table } = await shippedInBatches();
    const requestId = await requestReturnOk(cookie, orderId, [{ orderLineId: mugLine.id, quantity: 3 }]);
    await approveReturn(requestId);
    await receiveReturn(requestId, [{ orderLineId: mugLine.id, receivedQuantity: 3 }]);
    await inspectReturn(requestId, [{ orderLineId: mugLine.id, sellableQuantity: 3, damagedQuantity: 0 }]);

    await confirmLossOk(table, [{ orderLineId: tableLine.id, quantity: 1 }]);

    const refunds = await refundsOf(orderId);
    expect(splitOf(refunds)).toEqual([["return", 960, 100], ["loss", 6000, 600]]);
    expect(refunds.reduce((sum, refund) => sum + refund.amountTwd, 0)).toBe(7660);
  });
});

describe("確認遺失：退款失敗可復原與冪等", () => {
  it("退款明確失敗：遺失事實與批次進度不變、庫存不動，退款留在待辦，原紀錄重試後成功", async () => {
    const { orderId, gateway, tableVariantId, tableLine, table } = await shippedInBatches();
    const before = await stockDetail(tableVariantId);
    gateway.failNextRefundExplicitly();

    const confirmed = await confirmLossOk(table, [{ orderLineId: tableLine.id, quantity: 1 }]);

    expect(confirmed.refund).toMatchObject({ status: "failed" });
    expect(await stockDetail(tableVariantId)).toEqual(before);
    expect((await adminOrder(orderId)).shipments.find((shipment) => shipment.id === table)).toMatchObject({ deliveryStatus: "lost" });
    expect(await app.listRefundsToHandle(await mintAccessJwt())).toMatchObject({ ok: true, data: { refunds: [{ id: confirmed.refund!.id, reason: "loss", status: "failed" }] } });
    expect(await app.retryRefund(await mintAccessJwt(), { refundId: confirmed.refund!.id })).toMatchObject({ ok: true, data: { status: "succeeded" } });
    expect(await refundsOf(orderId)).toHaveLength(1);
  });

  it("額度被占用而尚未登記：遺失照常成立、列進退款待辦、通知不承諾自動退款；額度釋出後重送同一確認才登記並執行", async () => {
    const { cookie, orderId, totalTwd, tableLine, table } = await shippedInBatches();
    const payment = (await env.DB.prepare("SELECT id FROM payments WHERE order_id = ?").bind(orderId).first<{ id: number }>())!;
    expect(await commitRefund(env.DB, { paymentId: payment.id, reason: "cancelled_order", amountTwd: totalTwd - 100, goodsTwd: totalTwd - 100, shippingTwd: 0 }, Date.now())).not.toBeNull();
    const lossKey = "key-quota";
    const items = [{ orderLineId: tableLine.id, quantity: 1 }];

    const confirmed = await confirmLoss(table, items, { lossKey });

    expect(confirmed).toMatchObject({ ok: true, data: { replayed: false, refund: null } });
    expect((await adminOrder(orderId)).losses).toMatchObject([{ refund: null, goodsTwd: 6000 }]);
    expect(await app.listRefundsToHandle(await mintAccessJwt())).toMatchObject({ ok: true, data: { unregisteredLosses: [{ orderId, goodsTwd: 6000 }] } });
    expect(await bodyOf(cookie, "shipment_loss_confirmed")).toContain("客服會與你聯繫");

    await env.DB.prepare("DELETE FROM refunds WHERE reason = 'cancelled_order'").run();
    expect(await confirmLoss(table, items, { lossKey })).toMatchObject({ ok: true, data: { replayed: true, refund: { status: "succeeded" } } });
    expect(await app.listRefundsToHandle(await mintAccessJwt())).toMatchObject({ ok: true, data: { unregisteredLosses: [] } });
  });

  it("同鍵重送冪等（一筆遺失、一筆退款、一封通知），同鍵不同內容回 loss_key_conflict", async () => {
    const { cookie, orderId, mugLine, mugA } = await shippedInBatches();
    const lossKey = "key-idem";
    const items = [{ orderLineId: mugLine.id, quantity: 1 }];

    const first = await confirmLoss(mugA, items, { lossKey });
    const again = await confirmLoss(mugA, items, { lossKey });

    expect(first).toMatchObject({ ok: true, data: { replayed: false } });
    expect(again).toMatchObject({ ok: true, data: { replayed: true } });
    expect(await confirmLoss(mugA, [{ orderLineId: mugLine.id, quantity: 2 }], { lossKey })).toEqual({ ok: false, reason: "loss_key_conflict" });
    const order = await adminOrder(orderId);
    expect(order.losses).toHaveLength(1);
    expect(order.refunds).toHaveLength(1);
    expect((await mailOf(cookie)).filter((message) => message.kind === "shipment_loss_confirmed")).toHaveLength(1);
  });
});

describe("確認遺失：權限與輸入", () => {
  it("沒有管理員身分被拒絕；顧客不能讀別人訂單的遺失；輸入不合法被擋下", async () => {
    const { cookie, orderId, tableLine, table } = await shippedInBatches();
    await confirmLossOk(table, [{ orderLineId: tableLine.id, quantity: 1 }]);
    const bob = await signInCustomer("bob");

    expect(await app.confirmShipmentLoss("not-a-jwt", { shipmentId: table, lossKey: "k", items: [{ orderLineId: tableLine.id, quantity: 1 }] })).toEqual({ ok: false, reason: "unauthorized" });
    expect(await app.getMyOrder(bob, { orderId })).toEqual({ ok: false, reason: "order_not_found" });
    expect(await app.getMyOrder(cookie, { orderId })).toMatchObject({ ok: true, data: { losses: [{ shipmentId: table }] } });
    const jwt = await mintAccessJwt();
    expect(await app.confirmShipmentLoss(jwt, { shipmentId: table, lossKey: "k", items: [] })).toMatchObject({ ok: false, reason: "invalid_input" });
    expect(await app.confirmShipmentLoss(jwt, { shipmentId: table, lossKey: "bad key!", items: [{ orderLineId: 1, quantity: 1 }] })).toMatchObject({ ok: false, reason: "invalid_input" });
    expect(await app.confirmShipmentLoss(jwt, { shipmentId: table, lossKey: "k", items: [{ orderLineId: 1, quantity: 0 }] })).toMatchObject({ ok: false, reason: "invalid_input" });
  });
});
