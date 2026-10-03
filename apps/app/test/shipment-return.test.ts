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
import { declareReturn, declareReturnOk, inspectShipmentReturn, receiveShipmentReturn, returnAllSellable } from "./shipment-return-helpers";

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
const movementsOf = async (variantId: number) => {
  const listed = await app.listStockMovements(await mintAccessJwt(), { variantId, limit: 50 });
  if (!listed.ok) throw new Error("讀流水失敗");
  return listed.data.items;
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

describe("物流退回：入倉、不可售與退款", () => {
  it("登記不動庫存與款項；收回才增加在庫與不可售；檢查合格轉可售；退商品款加該類原運費，顧客收到通知", async () => {
    const { cookie, orderId, tableVariantId, tableLine, table } = await shippedInBatches();
    const before = await stockDetail(tableVariantId);

    const returnId = await declareReturnOk(table, [{ orderLineId: tableLine.id, quantity: 1 }]);

    expect(await stockDetail(tableVariantId)).toEqual(before);
    expect(await refundsOf(orderId)).toEqual([]);
    expect((await adminOrder(orderId)).shipments.find((shipment) => shipment.id === table)).toMatchObject({ deliveryStatus: "returned" });
    expect(await bodyOf(cookie, "shipment_return_declared")).toContain("重新下單");

    expect(await receiveShipmentReturn(returnId, [{ orderLineId: tableLine.id, receivedQuantity: 1 }])).toEqual({ ok: true, data: { returnId, status: "received", replayed: false } });
    expect(await stockDetail(tableVariantId)).toMatchObject({ onHand: before.onHand + 1, unavailable: before.unavailable + 1, available: before.available });
    expect(await refundsOf(orderId)).toEqual([]);

    const inspected = await inspectShipmentReturn(returnId, [{ orderLineId: tableLine.id, sellableQuantity: 1, damagedQuantity: 0 }]);

    expect(inspected).toMatchObject({ ok: true, data: { returnId, replayed: false, refund: { status: "succeeded" } } });
    expect(await stockDetail(tableVariantId)).toMatchObject({ onHand: before.onHand + 1, unavailable: before.unavailable, available: before.available + 1 });
    const movements = await movementsOf(tableVariantId);
    expect(movements.filter((movement) => movement.kind.startsWith("shipment_return"))).toMatchObject([
      { kind: "shipment_return_inspected", delta: 0, unavailableDelta: -1, shipmentReturnId: returnId, returnRequestId: null, orderId },
      { kind: "shipment_return_received", delta: 1, unavailableDelta: 1, shipmentReturnId: returnId, returnRequestId: null, orderId },
    ]);
    const order = await adminOrder(orderId);
    expect(order.refunds).toMatchObject([{ reason: "shipment_return", amountTwd: 6600, goodsTwd: 6000, shippingTwd: 600, status: "succeeded" }]);
    expect(order.shipmentReturns).toMatchObject([{ id: returnId, shipmentId: table, status: "completed", goodsTwd: 6000, shippingTwd: 600, actor: "admin@example.com", items: [{ orderLineId: tableLine.id, quantity: 1, receivedQuantity: 1, sellableQuantity: 1, damagedQuantity: 0, amountTwd: 6000 }], refund: { amountTwd: 6600 } }]);
    expect(order.returns).toEqual([]);
    expect(order.lines.find((line) => line.id === tableLine.id)).toMatchObject({ shipmentReturnedQuantity: 1, returnedQuantity: 0, lostQuantity: 0 });
    expect(await app.getMyOrder(cookie, { orderId })).toMatchObject({ ok: true, data: { shipmentReturns: [{ shipmentId: table, status: "completed", refund: { amountTwd: 6600 } }] } });
    expect((await mailOf(cookie)).map((message) => message.kind)).toEqual(expect.arrayContaining(["shipment_return_declared", "shipment_return_completed", "refund_succeeded"]));
    expect(await bodyOf(cookie, "shipment_return_completed")).toContain("退款完成會另行通知");
  });

  it("損壞品：照樣退款，損壞數量留在不可售；待檢時不能報廢，檢查後才能報廢", async () => {
    const { orderId, mugVariantId, mugLine, mugA } = await shippedInBatches();
    const before = await stockDetail(mugVariantId);
    const returnId = await declareReturnOk(mugA, [{ orderLineId: mugLine.id, quantity: 2 }]);
    await receiveShipmentReturn(returnId, [{ orderLineId: mugLine.id, receivedQuantity: 2 }]);
    const jwt = await mintAccessJwt();
    expect(await app.scrapUnavailableStock(jwt, { variantId: mugVariantId, quantity: 1, reason: "壞" })).toEqual({ ok: false, reason: "insufficient_unavailable" });

    expect(await inspectShipmentReturn(returnId, [{ orderLineId: mugLine.id, sellableQuantity: 1, damagedQuantity: 1 }])).toMatchObject({ ok: true });

    expect(await stockDetail(mugVariantId)).toMatchObject({ onHand: before.onHand + 2, unavailable: before.unavailable + 1, available: before.available + 1 });
    expect(splitOf(await refundsOf(orderId))).toEqual([["shipment_return", 640, 100]]);
    expect(await app.scrapUnavailableStock(jwt, { variantId: mugVariantId, quantity: 1, reason: "壞" })).toMatchObject({ ok: true, data: { onHand: before.onHand + 1, unavailable: before.unavailable } });
    expect((await movementsOf(mugVariantId)).filter((movement) => movement.kind === "scrap")).toHaveLength(1);
  });

  it("沒收到任何東西：結案、不動庫存與款項，占用的數量釋出，可再登記", async () => {
    const { orderId, mugVariantId, mugLine, mugB } = await shippedInBatches();
    const before = await stockDetail(mugVariantId);
    const returnId = await declareReturnOk(mugB, [{ orderLineId: mugLine.id, quantity: 1 }]);
    expect(await declareReturn(mugB, [{ orderLineId: mugLine.id, quantity: 1 }])).toEqual({ ok: false, reason: "return_quantity_exceeded" });

    expect(await receiveShipmentReturn(returnId, [{ orderLineId: mugLine.id, receivedQuantity: 0 }])).toMatchObject({ ok: true, data: { status: "not_received" } });

    expect(await stockDetail(mugVariantId)).toEqual(before);
    expect(await refundsOf(orderId)).toEqual([]);
    expect(await inspectShipmentReturn(returnId, [{ orderLineId: mugLine.id, sellableQuantity: 0, damagedQuantity: 0 }])).toEqual({ ok: false, reason: "shipment_return_wrong_state" });
    expect(await declareReturn(mugB, [{ orderLineId: mugLine.id, quantity: 1 }])).toMatchObject({ ok: true });
  });

  it("部分收回：只退實際收到的數量，沒收到的釋出", async () => {
    const { orderId, mugLine, mugA } = await shippedInBatches();
    const returnId = await declareReturnOk(mugA, [{ orderLineId: mugLine.id, quantity: 2 }]);

    await receiveShipmentReturn(returnId, [{ orderLineId: mugLine.id, receivedQuantity: 1 }]);
    expect(await receiveShipmentReturn(returnId, [{ orderLineId: mugLine.id, receivedQuantity: 3 }])).toEqual({ ok: false, reason: "shipment_return_item_invalid" });
    expect(await inspectShipmentReturn(returnId, [{ orderLineId: mugLine.id, sellableQuantity: 2, damagedQuantity: 0 }])).toEqual({ ok: false, reason: "shipment_return_item_invalid" });
    await inspectShipmentReturn(returnId, [{ orderLineId: mugLine.id, sellableQuantity: 1, damagedQuantity: 0 }]);

    expect(splitOf(await refundsOf(orderId))).toEqual([["shipment_return", 320, 100]]);
  });

  it("商品款按原實付單價（改價不影響）", async () => {
    const { orderId, mugLine, mugVariantId, mugA } = await shippedInBatches();
    await env.DB.prepare("UPDATE product_variants SET price_twd = 999 WHERE id = ?").bind(mugVariantId).run();

    await returnAllSellable(mugA, [{ orderLineId: mugLine.id, quantity: 1 }]);

    expect(splitOf(await refundsOf(orderId))).toEqual([["shipment_return", 320, 100]]);
  });

  it("回倉後不恢復原單履約：已交運數量維持已交運，不能再從同單交運", async () => {
    const { orderId, tableLine, table } = await shippedInBatches();
    await returnAllSellable(table, [{ orderLineId: tableLine.id, quantity: 1 }]);

    const again = await app.shipOrder(await mintAccessJwt(), { orderId, dispatchKey: "again", items: [{ orderLineId: tableLine.id, quantity: 1 }], appointment: { start: Date.now() + 86_400_000, end: Date.now() + 90_000_000 } });

    expect(again.ok).toBe(false);
    expect((await adminOrder(orderId)).lines.find((line) => line.id === tableLine.id)).toMatchObject({ shippedQuantity: 1, shipmentReturnedQuantity: 1 });
  });
});

describe("物流退回：運費只退一次（Q25）", () => {
  it("任一該類退回就退該類原運費一次，即使同類其他批已送達", async () => {
    const { orderId, mugLine, mugA, mugB } = await shippedInBatches();
    expect(await reportAfter(orderId, mugA, "ev-a", "delivered")).toMatchObject({ ok: true });

    await returnAllSellable(mugB, [{ orderLineId: mugLine.id, quantity: 1 }]);

    expect(splitOf(await refundsOf(orderId))).toEqual([["shipment_return", 320, 100]]);
  });

  it("同類第二案物流退回只退商品款（運費已退過）", async () => {
    const { orderId, mugLine, mugA, mugB } = await shippedInBatches();

    await returnAllSellable(mugB, [{ orderLineId: mugLine.id, quantity: 1 }]);
    await returnAllSellable(mugA, [{ orderLineId: mugLine.id, quantity: 2 }]);

    expect(splitOf(await refundsOf(orderId))).toEqual([["shipment_return", 320, 100], ["shipment_return", 640, 0]]);
  });

  it("遺失在先退運費，之後同類物流退回不再退運費；反過來物流退回在先，之後遺失也不再退", async () => {
    const lostFirst = await shippedInBatches();
    await confirmLossOk(lostFirst.mugB, [{ orderLineId: lostFirst.mugLine.id, quantity: 1 }]);
    await returnAllSellable(lostFirst.mugA, [{ orderLineId: lostFirst.mugLine.id, quantity: 2 }]);
    expect(splitOf(await refundsOf(lostFirst.orderId))).toEqual([["loss", 320, 100], ["shipment_return", 640, 0]]);

    await resetDb();
    const returnedFirst = await shippedInBatches();
    await returnAllSellable(returnedFirst.mugA, [{ orderLineId: returnedFirst.mugLine.id, quantity: 2 }]);
    await confirmLossOk(returnedFirst.mugB, [{ orderLineId: returnedFirst.mugLine.id, quantity: 1 }]);
    expect(splitOf(await refundsOf(returnedFirst.orderId))).toEqual([["shipment_return", 640, 100], ["loss", 320, 0]]);
  });

  it("物流退回在先退運費，之後取消其餘數量即使同類全退出也不再退運費，合計不超過實付", async () => {
    const { cookie, orderId, mugLine } = await paidMixedOrder();
    const mugBatch = await shipItems(orderId, [{ orderLineId: mugLine.id, quantity: 1 }]);
    await returnAllSellable(mugBatch, [{ orderLineId: mugLine.id, quantity: 1 }]);

    await approveOk(await requestCancelOk(cookie, orderId, [{ orderLineId: mugLine.id, quantity: 2 }]));

    const refunds = await refundsOf(orderId);
    expect(splitOf(refunds)).toEqual([["shipment_return", 320, 100], ["cancellation", 640, 0]]);
    expect(refunds.reduce((sum, refund) => sum + refund.amountTwd, 0)).toBe(3 * 320 + 100);
  });

  it("取消在先（不符全退出、不退運費），之後物流退回才退一次運費", async () => {
    const { cookie, orderId, mugLine } = await paidMixedOrder();
    const mugBatch = await shipItems(orderId, [{ orderLineId: mugLine.id, quantity: 1 }]);
    await approveOk(await requestCancelOk(cookie, orderId, [{ orderLineId: mugLine.id, quantity: 2 }]));

    await returnAllSellable(mugBatch, [{ orderLineId: mugLine.id, quantity: 1 }]);

    expect(splitOf(await refundsOf(orderId))).toEqual([["cancellation", 640, 0], ["shipment_return", 320, 100]]);
  });

  it("退貨完成在先已退該類運費，同單另一類的物流退回只退另一類的運費", async () => {
    const { cookie, orderId, mugLine, tableLine, table } = await shippedInBatches();
    const requestId = await requestReturnOk(cookie, orderId, [{ orderLineId: mugLine.id, quantity: 3 }]);
    await approveReturn(requestId);
    await receiveReturn(requestId, [{ orderLineId: mugLine.id, receivedQuantity: 3 }]);
    await inspectReturn(requestId, [{ orderLineId: mugLine.id, sellableQuantity: 3, damagedQuantity: 0 }]);

    await returnAllSellable(table, [{ orderLineId: tableLine.id, quantity: 1 }]);

    const refunds = await refundsOf(orderId);
    expect(splitOf(refunds)).toEqual([["return", 960, 100], ["shipment_return", 6000, 600]]);
    expect(refunds.reduce((sum, refund) => sum + refund.amountTwd, 0)).toBe(7660);
  });

  it("物流退回完成在先，之後另一筆顧客退貨即使同類全退出也不再退運費", async () => {
    const { cookie, orderId, mugLine, mugB } = await shippedInBatches();
    await returnAllSellable(mugB, [{ orderLineId: mugLine.id, quantity: 1 }]);
    const requestId = await requestReturnOk(cookie, orderId, [{ orderLineId: mugLine.id, quantity: 2 }]);
    await approveReturn(requestId);
    await receiveReturn(requestId, [{ orderLineId: mugLine.id, receivedQuantity: 2 }]);

    await inspectReturn(requestId, [{ orderLineId: mugLine.id, sellableQuantity: 2, damagedQuantity: 0 }]);

    expect(splitOf(await refundsOf(orderId))).toEqual([["shipment_return", 320, 100], ["return", 640, 0]]);
  });
});

describe("物流退回：已遺失的貨被尋回", () => {
  it("遺失退款之後尋回退回入倉：入庫、轉可售，但不再退款；遺失紀錄與退款不變", async () => {
    const { cookie, orderId, tableVariantId, tableLine, table } = await shippedInBatches();
    await confirmLossOk(table, [{ orderLineId: tableLine.id, quantity: 1 }]);
    const before = await stockDetail(tableVariantId);

    const returnId = await declareReturnOk(table, [{ orderLineId: tableLine.id, quantity: 0, foundLostQuantity: 1 }]);
    await receiveShipmentReturn(returnId, [{ orderLineId: tableLine.id, receivedQuantity: 0, receivedFoundLostQuantity: 1 }]);
    expect(await stockDetail(tableVariantId)).toMatchObject({ onHand: before.onHand + 1, unavailable: before.unavailable + 1 });
    const inspected = await inspectShipmentReturn(returnId, [{ orderLineId: tableLine.id, sellableQuantity: 1, damagedQuantity: 0 }]);

    expect(inspected).toMatchObject({ ok: true, data: { refund: null } });
    expect(await stockDetail(tableVariantId)).toMatchObject({ onHand: before.onHand + 1, unavailable: before.unavailable, available: before.available + 1 });
    const order = await adminOrder(orderId);
    expect(splitOf(order.refunds)).toEqual([["loss", 6000, 600]]);
    expect(order.losses).toHaveLength(1);
    expect(order.shipmentReturns).toMatchObject([{ status: "completed", goodsTwd: 0, shippingTwd: 0, refund: null, items: [{ quantity: 0, foundLostQuantity: 1, receivedFoundLostQuantity: 1 }] }]);
    expect(order.shipments.find((shipment) => shipment.id === table)).toMatchObject({ deliveryStatus: "lost" });
    expect(order.lines.find((line) => line.id === tableLine.id)).toMatchObject({ lostQuantity: 1, shipmentReturnedQuantity: 0 });
    expect(await app.listRefundsToHandle(await mintAccessJwt())).toMatchObject({ ok: true, data: { unregisteredShipmentReturns: [] } });
    expect(await bodyOf(cookie, "shipment_return_completed")).toContain("沒有需要退款的金額");
    // 已遺失的數量仍不可再退貨
    expect(await requestReturn(cookie, orderId, [{ orderLineId: tableLine.id, quantity: 1 }])).toEqual({ ok: false, reason: "return_quantity_exceeded" });
  });

  it("尋回數量不能超過該批確認遺失的數量（含已登記尋回的）；沒有遺失就不能標示尋回；沒收到的尋回品釋出可再登記", async () => {
    const { mugLine, mugA, mugB } = await shippedInBatches();
    expect(await declareReturn(mugA, [{ orderLineId: mugLine.id, quantity: 0, foundLostQuantity: 1 }])).toEqual({ ok: false, reason: "return_quantity_exceeded" });
    await confirmLossOk(mugA, [{ orderLineId: mugLine.id, quantity: 2 }]);

    const first = await declareReturnOk(mugA, [{ orderLineId: mugLine.id, quantity: 0, foundLostQuantity: 1 }]);
    expect(await declareReturn(mugA, [{ orderLineId: mugLine.id, quantity: 0, foundLostQuantity: 2 }])).toEqual({ ok: false, reason: "return_quantity_exceeded" });
    expect(await declareReturn(mugB, [{ orderLineId: mugLine.id, quantity: 0, foundLostQuantity: 1 }])).toEqual({ ok: false, reason: "return_quantity_exceeded" });
    await receiveShipmentReturn(first, [{ orderLineId: mugLine.id, receivedQuantity: 0, receivedFoundLostQuantity: 0 }]);

    expect(await declareReturn(mugA, [{ orderLineId: mugLine.id, quantity: 0, foundLostQuantity: 2 }])).toMatchObject({ ok: true });
  });

  it("同一案同時含新退回與尋回的遺失品：只退新退回的數量，兩種都入庫", async () => {
    const { orderId, mugVariantId, mugLine, mugA } = await shippedInBatches();
    // mugA 2 件：1 件遺失（已退款 320 + 運費 100），另 1 件這次一起被退回
    await confirmLossOk(mugA, [{ orderLineId: mugLine.id, quantity: 1 }]);
    const before = await stockDetail(mugVariantId);
    const returnId = await declareReturnOk(mugA, [{ orderLineId: mugLine.id, quantity: 1, foundLostQuantity: 1 }]);

    await receiveShipmentReturn(returnId, [{ orderLineId: mugLine.id, receivedQuantity: 1, receivedFoundLostQuantity: 1 }]);
    const inspected = await inspectShipmentReturn(returnId, [{ orderLineId: mugLine.id, sellableQuantity: 2, damagedQuantity: 0 }]);

    expect(inspected).toMatchObject({ ok: true });
    expect(await stockDetail(mugVariantId)).toMatchObject({ onHand: before.onHand + 2, unavailable: before.unavailable });
    expect(splitOf(await refundsOf(orderId))).toEqual([["loss", 320, 100], ["shipment_return", 320, 0]]);
  });
});

describe("物流退回：與物流回報的先後與批次結局", () => {
  it("登記之後才到的送達、失敗、再次配送回報只留紀錄：進度仍是退回、不寄送達通知；送達回報照記實際送達時間", async () => {
    const { cookie, orderId, tableLine, table } = await shippedInBatches();
    await reportAfter(orderId, table, "ev-1", "delivery_failed", 30);
    await declareReturnOk(table, [{ orderLineId: tableLine.id, quantity: 1 }]);

    expect(await reportAfter(orderId, table, "ev-late", "delivered", 90)).toMatchObject({ ok: true, data: { deliveryStatus: "returned", deliveredAt: expect.any(Number) } });
    expect(await reportAfter(orderId, table, "ev-late-2", "redelivery", 120)).toMatchObject({ ok: true, data: { deliveryStatus: "returned" } });
    expect(await reportAfter(orderId, table, "ev-late-3", "delivery_failed", 150)).toMatchObject({ ok: true, data: { deliveryStatus: "returned" } });

    const shipment = await adminShipment(orderId, table);
    expect(shipment.events.map((event) => [event.eventKey, event.noticeExpected])).toEqual([["ev-1", false], ["ev-late", false], ["ev-late-2", false], ["ev-late-3", false]]);
    const kinds = (await mailOf(cookie)).map((message) => message.kind);
    expect(kinds).not.toContain("shipment_delivered");
    expect(kinds.filter((kind) => kind === "shipment_delivery_failed")).toHaveLength(1);
    expect((await adminOrder(orderId)).shipmentReturns).toHaveLength(1);
  });

  it("已送達是終點：送達之後不能登記物流退回；暫時配送失敗中的批次可以登記", async () => {
    const { orderId, mugLine, mugA, mugB } = await shippedInBatches();
    await reportAfter(orderId, mugA, "ev-d", "delivered", 30);
    await reportAfter(orderId, mugB, "ev-f", "delivery_failed", 30);

    expect(await declareReturn(mugA, [{ orderLineId: mugLine.id, quantity: 1 }])).toEqual({ ok: false, reason: "shipment_delivered" });
    expect(await declareReturn(mugB, [{ orderLineId: mugLine.id, quantity: 1 }])).toMatchObject({ ok: true });
    expect((await adminOrder(orderId)).shipments.find((shipment) => shipment.id === mugB)).toMatchObject({ deliveryStatus: "returned" });
  });

  it("部分退回之後才送達：仍是退回但已送達，不能再登記；送達通知只列未退回的數量", async () => {
    const { cookie, orderId, mugLine, mugA } = await shippedInBatches();
    await declareReturnOk(mugA, [{ orderLineId: mugLine.id, quantity: 1 }]);
    await reportAfter(orderId, mugA, "ev-late", "delivered", 30);

    expect(await declareReturn(mugA, [{ orderLineId: mugLine.id, quantity: 1 }])).toEqual({ ok: false, reason: "shipment_delivered" });

    expect(await adminShipment(orderId, mugA)).toMatchObject({ deliveryStatus: "returned", deliveredAt: expect.any(Number), events: [{ eventKey: "ev-late", noticeExpected: true, noticeMessageId: expect.any(Number) }] });
    const body = await bodyOf(cookie, "shipment_delivered");
    expect(body).toContain("× 1");
    expect(body).not.toContain("× 2");
    expect(body).toContain("被物流退回倉庫");
  });

  it("遺失優先於物流退回：同一批先退回後確認遺失，進度是遺失，之後的回報只留紀錄", async () => {
    const { orderId, mugLine, mugA } = await shippedInBatches();
    await declareReturnOk(mugA, [{ orderLineId: mugLine.id, quantity: 1 }]);
    await confirmLossOk(mugA, [{ orderLineId: mugLine.id, quantity: 1 }]);

    expect(await adminShipment(orderId, mugA)).toMatchObject({ deliveryStatus: "lost" });
    expect(await reportAfter(orderId, mugA, "ev-late", "redelivery", 60)).toMatchObject({ ok: true, data: { deliveryStatus: "lost" } });
  });

  it("先遺失後登記退回（遺失之外的數量）：進度仍是遺失", async () => {
    const { orderId, mugLine, mugA } = await shippedInBatches();
    await confirmLossOk(mugA, [{ orderLineId: mugLine.id, quantity: 1 }]);

    await declareReturnOk(mugA, [{ orderLineId: mugLine.id, quantity: 1 }]);

    expect(await adminShipment(orderId, mugA)).toMatchObject({ deliveryStatus: "lost" });
  });

  it("全數退回的批次，之後的送達回報不寄送達通知", async () => {
    const { cookie, orderId, tableLine, table } = await shippedInBatches();
    await returnAllSellable(table, [{ orderLineId: tableLine.id, quantity: 1 }]);

    await reportAfter(orderId, table, "ev-late", "delivered", 30);

    expect((await mailOf(cookie)).map((message) => message.kind)).not.toContain("shipment_delivered");
    expect((await adminShipment(orderId, table)).events).toMatchObject([{ eventKey: "ev-late", noticeExpected: false }]);
  });
});

describe("物流退回：未收到結案後批次進度重算", () => {
  it("登記、未收到結案、之後送達：進度是已送達，送達信不含退回字樣、列全部數量", async () => {
    const { cookie, orderId, mugLine, mugA } = await shippedInBatches();
    const returnId = await declareReturnOk(mugA, [{ orderLineId: mugLine.id, quantity: 2 }]);
    await receiveShipmentReturn(returnId, [{ orderLineId: mugLine.id, receivedQuantity: 0 }]);
    expect(await adminShipment(orderId, mugA)).toMatchObject({ deliveryStatus: "in_transit" });

    expect(await reportAfter(orderId, mugA, "ev-d", "delivered", 30)).toMatchObject({ ok: true, data: { deliveryStatus: "delivered" } });

    const body = await bodyOf(cookie, "shipment_delivered");
    expect(body).toContain("× 2");
    expect(body).not.toContain("退回");
  });

  it("未收到結案後的配送失敗會寄信、進度是配送失敗", async () => {
    const { cookie, orderId, mugLine, mugA } = await shippedInBatches();
    const returnId = await declareReturnOk(mugA, [{ orderLineId: mugLine.id, quantity: 2 }]);
    await receiveShipmentReturn(returnId, [{ orderLineId: mugLine.id, receivedQuantity: 0 }]);

    expect(await reportAfter(orderId, mugA, "ev-f", "delivery_failed", 30)).toMatchObject({ ok: true, data: { deliveryStatus: "delivery_failed" } });

    expect((await mailOf(cookie)).filter((message) => message.kind === "shipment_delivery_failed")).toHaveLength(1);
    expect((await adminShipment(orderId, mugA)).events).toMatchObject([{ eventKey: "ev-f", noticeExpected: true, noticeMessageId: expect.any(Number) }]);
  });

  it("未收到結案後同批的其餘數量仍可再登記，進度回到退回", async () => {
    const { orderId, mugLine, mugA } = await shippedInBatches();
    const returnId = await declareReturnOk(mugA, [{ orderLineId: mugLine.id, quantity: 2 }]);
    await receiveShipmentReturn(returnId, [{ orderLineId: mugLine.id, receivedQuantity: 0 }]);

    await declareReturnOk(mugA, [{ orderLineId: mugLine.id, quantity: 2 }]);

    expect(await adminShipment(orderId, mugA)).toMatchObject({ deliveryStatus: "returned" });
  });
});

describe("物流退回：占用的邊界（跨批與部分收回）", () => {
  it("該批已遺失的數量加本次超過該批數量被擋（批次層）", async () => {
    const { mugLine, mugA } = await shippedInBatches();
    await confirmLossOk(mugA, [{ orderLineId: mugLine.id, quantity: 1 }]);

    expect(await declareReturn(mugA, [{ orderLineId: mugLine.id, quantity: 2 }])).toEqual({ ok: false, reason: "return_quantity_exceeded" });
    expect(await declareReturn(mugA, [{ orderLineId: mugLine.id, quantity: 1 }])).toMatchObject({ ok: true });
  });

  it("別批的遺失與退貨占用合計用完明細數量時，這一批即使批次層有空間也被擋（明細層）", async () => {
    const { cookie, orderId, mugLine, mugA, mugB } = await shippedInBatches();
    await confirmLossOk(mugB, [{ orderLineId: mugLine.id, quantity: 1 }]);
    await requestReturnOk(cookie, orderId, [{ orderLineId: mugLine.id, quantity: 2 }]);

    expect(await declareReturn(mugA, [{ orderLineId: mugLine.id, quantity: 1 }])).toEqual({ ok: false, reason: "return_quantity_exceeded" });
  });

  it("別批的物流退回與退貨占用合計用完明細數量時，確認這一批遺失被擋（明細層）", async () => {
    const { cookie, orderId, mugLine, mugA, mugB } = await shippedInBatches();
    await declareReturnOk(mugA, [{ orderLineId: mugLine.id, quantity: 2 }]);
    await requestReturnOk(cookie, orderId, [{ orderLineId: mugLine.id, quantity: 1 }]);

    expect(await confirmLoss(mugB, [{ orderLineId: mugLine.id, quantity: 1 }])).toEqual({ ok: false, reason: "loss_quantity_exceeded" });
  });

  it("部分收回後只占用實際收到的數量：同批與跨批的新登記、遺失用掉釋出的部分才成功，再多就被擋", async () => {
    const { mugLine, mugA, mugB } = await shippedInBatches();
    await confirmLossOk(mugB, [{ orderLineId: mugLine.id, quantity: 1 }]);
    const returnId = await declareReturnOk(mugA, [{ orderLineId: mugLine.id, quantity: 2 }]);
    await receiveShipmentReturn(returnId, [{ orderLineId: mugLine.id, receivedQuantity: 1 }]);

    // 已遺失 1、收回 1：明細還剩 1，批次 A 也剩 1
    expect(await declareReturn(mugA, [{ orderLineId: mugLine.id, quantity: 2 }])).toEqual({ ok: false, reason: "return_quantity_exceeded" });
    expect(await declareReturn(mugA, [{ orderLineId: mugLine.id, quantity: 1 }])).toMatchObject({ ok: true });
    expect(await confirmLoss(mugA, [{ orderLineId: mugLine.id, quantity: 1 }])).toEqual({ ok: false, reason: "loss_quantity_exceeded" });
  });

  it("部分收回後釋出的數量可以確認遺失", async () => {
    const { mugLine, mugA } = await shippedInBatches();
    const returnId = await declareReturnOk(mugA, [{ orderLineId: mugLine.id, quantity: 2 }]);
    await receiveShipmentReturn(returnId, [{ orderLineId: mugLine.id, receivedQuantity: 1 }]);

    expect(await confirmLoss(mugA, [{ orderLineId: mugLine.id, quantity: 1 }])).toMatchObject({ ok: true });
    expect(await confirmLoss(mugA, [{ orderLineId: mugLine.id, quantity: 1 }])).toEqual({ ok: false, reason: "loss_quantity_exceeded" });
  });
});

describe("物流退回：庫存轉換只成立一次", () => {
  it("並行收回（同內容）：入庫與流水只成立一次，兩邊都回成功", async () => {
    const { tableVariantId, tableLine, table } = await shippedInBatches();
    const before = await stockDetail(tableVariantId);
    const returnId = await declareReturnOk(table, [{ orderLineId: tableLine.id, quantity: 1 }]);

    const results = await Promise.all([0, 1].map(() => receiveShipmentReturn(returnId, [{ orderLineId: tableLine.id, receivedQuantity: 1 }])));

    expect(results.every((result) => result.ok)).toBe(true);
    expect(await stockDetail(tableVariantId)).toMatchObject({ onHand: before.onHand + 1, unavailable: before.unavailable + 1 });
    expect((await movementsOf(tableVariantId)).filter((movement) => movement.kind === "shipment_return_received")).toHaveLength(1);
  });

  it("已完成的案件同內容重送檢查：庫存數字與流水都不再變動", async () => {
    const { mugVariantId, mugLine, mugA } = await shippedInBatches();
    const returnId = await declareReturnOk(mugA, [{ orderLineId: mugLine.id, quantity: 2 }]);
    await receiveShipmentReturn(returnId, [{ orderLineId: mugLine.id, receivedQuantity: 2 }]);
    const items = [{ orderLineId: mugLine.id, sellableQuantity: 1, damagedQuantity: 1 }];
    await inspectShipmentReturn(returnId, items);
    const after = await stockDetail(mugVariantId);

    expect(await inspectShipmentReturn(returnId, items)).toMatchObject({ ok: true, data: { replayed: true } });

    expect(await stockDetail(mugVariantId)).toEqual(after);
    expect((await movementsOf(mugVariantId)).filter((movement) => movement.kind === "shipment_return_inspected")).toHaveLength(1);
  });
});

describe("物流退回：數量與退貨、遺失互斥", () => {
  it("明細不在這一批、超過該批數量、已被占用的數量都被擋下；不存在的批次回 shipment_not_found", async () => {
    const { mugLine, tableLine, mugA, mugB } = await shippedInBatches();

    expect(await declareReturn(mugA, [{ orderLineId: tableLine.id, quantity: 1 }])).toEqual({ ok: false, reason: "return_line_invalid" });
    expect(await declareReturn(mugB, [{ orderLineId: mugLine.id, quantity: 2 }])).toEqual({ ok: false, reason: "return_quantity_exceeded" });
    await declareReturnOk(mugB, [{ orderLineId: mugLine.id, quantity: 1 }]);
    expect(await declareReturn(mugB, [{ orderLineId: mugLine.id, quantity: 1 }])).toEqual({ ok: false, reason: "return_quantity_exceeded" });
    expect(await declareReturn(999999, [{ orderLineId: mugLine.id, quantity: 1 }])).toEqual({ ok: false, reason: "shipment_not_found" });
  });

  it("退回占用的數量不可再被退貨申請與遺失占用；退貨與遺失占用的數量也不可退回；未收到釋出後又可使用", async () => {
    const { cookie, orderId, mugLine, mugA, mugB } = await shippedInBatches();
    const returnId = await declareReturnOk(mugB, [{ orderLineId: mugLine.id, quantity: 1 }]);

    // 已交運 3、退回 1：只剩 2 可退貨
    expect(await requestReturn(cookie, orderId, [{ orderLineId: mugLine.id, quantity: 3 }])).toEqual({ ok: false, reason: "return_quantity_exceeded" });
    expect(await confirmLoss(mugB, [{ orderLineId: mugLine.id, quantity: 1 }])).toEqual({ ok: false, reason: "loss_quantity_exceeded" });
    const requestId = await requestReturnOk(cookie, orderId, [{ orderLineId: mugLine.id, quantity: 2 }]);
    expect(await declareReturn(mugA, [{ orderLineId: mugLine.id, quantity: 1 }])).toEqual({ ok: false, reason: "return_quantity_exceeded" });

    expect(await app.decideReturn(await mintAccessJwt(), { requestId, decision: "reject" })).toMatchObject({ ok: true });
    await receiveShipmentReturn(returnId, [{ orderLineId: mugLine.id, receivedQuantity: 0 }]);
    expect(await confirmLoss(mugB, [{ orderLineId: mugLine.id, quantity: 1 }])).toMatchObject({ ok: true });
    expect(await declareReturn(mugA, [{ orderLineId: mugLine.id, quantity: 2 }])).toMatchObject({ ok: true });
  });

  it("自助退貨可申請的數量扣掉物流退回", async () => {
    const { cookie, orderId, mugLine, mugA } = await shippedInBatches();
    await declareReturnOk(mugA, [{ orderLineId: mugLine.id, quantity: 1 }]);
    await reportAfter(orderId, mugA, "ev-d", "delivered", 30);

    const mine = await app.getMyOrder(cookie, { orderId });

    expect(mine).toMatchObject({ ok: true, data: { returnBatches: expect.arrayContaining([expect.objectContaining({ shipmentId: mugA, state: "open", items: [expect.objectContaining({ quantity: 2, selfServiceQuantity: 1 })] })]) } });
    expect(await requestReturn(cookie, orderId, [{ orderLineId: mugLine.id, shipmentId: mugA, quantity: 2 }])).toEqual({ ok: false, reason: "return_quantity_exceeded" });
    expect(await requestReturn(cookie, orderId, [{ orderLineId: mugLine.id, shipmentId: mugA, quantity: 1 }])).toMatchObject({ ok: true });
  });

  it("物流退回與退貨申請同時搶最後的數量，只有一邊成立", async () => {
    const { cookie, orderId, mugLine, mugA } = await shippedInBatches();

    const [returned, declared] = await Promise.all([
      requestReturn(cookie, orderId, [{ orderLineId: mugLine.id, quantity: 3 }]),
      declareReturn(mugA, [{ orderLineId: mugLine.id, quantity: 2 }]),
    ]);

    expect([returned.ok, declared.ok].filter(Boolean)).toHaveLength(1);
    const order = await adminOrder(orderId);
    expect(order.returns.length + order.shipmentReturns.length).toBe(1);
  });

  it("物流退回與確認遺失同時搶最後的數量，只有一邊成立", async () => {
    const { orderId, mugLine, mugA } = await shippedInBatches();

    const [lost, declared] = await Promise.all([confirmLoss(mugA, [{ orderLineId: mugLine.id, quantity: 2 }]), declareReturn(mugA, [{ orderLineId: mugLine.id, quantity: 2 }])]);

    expect([lost.ok, declared.ok].filter(Boolean)).toHaveLength(1);
    const order = await adminOrder(orderId);
    expect(order.losses.length + order.shipmentReturns.length).toBe(1);
  });

  it("兩次不同鍵的退回同時搶同一份數量，只有一邊成立", async () => {
    const { orderId, mugLine, mugB } = await shippedInBatches();

    const twice = await Promise.all([declareReturn(mugB, [{ orderLineId: mugLine.id, quantity: 1 }]), declareReturn(mugB, [{ orderLineId: mugLine.id, quantity: 1 }])]);

    expect(twice.filter((result) => result.ok)).toHaveLength(1);
    expect((await adminOrder(orderId)).shipmentReturns).toHaveLength(1);
  });
});

describe("物流退回：退款失敗與通知可復原、冪等", () => {
  it("退款明確失敗：入倉結果不變，退款留在待辦，原紀錄重試後成功", async () => {
    const { orderId, gateway, tableVariantId, tableLine, table } = await shippedInBatches();
    const before = await stockDetail(tableVariantId);
    const returnId = await declareReturnOk(table, [{ orderLineId: tableLine.id, quantity: 1 }]);
    await receiveShipmentReturn(returnId, [{ orderLineId: tableLine.id, receivedQuantity: 1 }]);
    gateway.failNextRefundExplicitly();

    const inspected = await inspectShipmentReturn(returnId, [{ orderLineId: tableLine.id, sellableQuantity: 1, damagedQuantity: 0 }]);

    expect(inspected).toMatchObject({ ok: true, data: { refund: { status: "failed" } } });
    expect(await stockDetail(tableVariantId)).toMatchObject({ onHand: before.onHand + 1, unavailable: before.unavailable });
    const refundId = inspected.ok ? inspected.data.refund!.id : 0;
    expect(await app.listRefundsToHandle(await mintAccessJwt())).toMatchObject({ ok: true, data: { refunds: [{ id: refundId, reason: "shipment_return", status: "failed" }] } });
    expect(await app.retryRefund(await mintAccessJwt(), { refundId })).toMatchObject({ ok: true, data: { status: "succeeded" } });
    expect(await refundsOf(orderId)).toHaveLength(1);
  });

  it("額度被占用而尚未登記：檢查照常完成、列進退款待辦、通知不承諾自動退款；額度釋出後重送同一次檢查才登記並執行", async () => {
    const { cookie, orderId, totalTwd, tableLine, table } = await shippedInBatches();
    const payment = (await env.DB.prepare("SELECT id FROM payments WHERE order_id = ?").bind(orderId).first<{ id: number }>())!;
    expect(await commitRefund(env.DB, { paymentId: payment.id, reason: "cancelled_order", amountTwd: totalTwd - 100, goodsTwd: totalTwd - 100, shippingTwd: 0 }, Date.now())).not.toBeNull();
    const returnId = await declareReturnOk(table, [{ orderLineId: tableLine.id, quantity: 1 }]);
    await receiveShipmentReturn(returnId, [{ orderLineId: tableLine.id, receivedQuantity: 1 }]);
    const items = [{ orderLineId: tableLine.id, sellableQuantity: 1, damagedQuantity: 0 }];

    const inspected = await inspectShipmentReturn(returnId, items);

    expect(inspected).toMatchObject({ ok: true, data: { replayed: false, refund: null } });
    expect((await adminOrder(orderId)).shipmentReturns).toMatchObject([{ status: "completed", refund: null, goodsTwd: 6000 }]);
    expect(await app.listRefundsToHandle(await mintAccessJwt())).toMatchObject({ ok: true, data: { unregisteredShipmentReturns: [{ orderId, goodsTwd: 6000 }] } });
    expect(await bodyOf(cookie, "shipment_return_completed")).toContain("客服會與你聯繫");

    await env.DB.prepare("DELETE FROM refunds WHERE reason = 'cancelled_order'").run();
    expect(await inspectShipmentReturn(returnId, items)).toMatchObject({ ok: true, data: { replayed: true, refund: { status: "succeeded" } } });
    expect(await app.listRefundsToHandle(await mintAccessJwt())).toMatchObject({ ok: true, data: { unregisteredShipmentReturns: [] } });
  });

  it("同內容重送冪等（一個案件、一筆流水、一筆退款、各一封通知）；內容不同被擋下", async () => {
    const { cookie, orderId, tableVariantId, tableLine, table } = await shippedInBatches();
    const returnKey = "key-idem";
    const items = [{ orderLineId: tableLine.id, quantity: 1 }];

    const first = await declareReturn(table, items, { returnKey });
    const again = await declareReturn(table, items, { returnKey });
    const returnId = first.ok ? first.data.returnId : 0;
    const receipt = [{ orderLineId: tableLine.id, receivedQuantity: 1 }];
    await receiveShipmentReturn(returnId, receipt);
    const receiptAgain = await receiveShipmentReturn(returnId, receipt);
    const inspection = [{ orderLineId: tableLine.id, sellableQuantity: 1, damagedQuantity: 0 }];
    await inspectShipmentReturn(returnId, inspection);
    const inspectionAgain = await inspectShipmentReturn(returnId, inspection);

    expect(first).toMatchObject({ ok: true, data: { replayed: false } });
    expect(again).toMatchObject({ ok: true, data: { replayed: true, returnId } });
    expect(await declareReturn(table, [{ orderLineId: tableLine.id, quantity: 1, foundLostQuantity: 0 }], { returnKey, note: "別的備註" })).toEqual({ ok: false, reason: "return_key_conflict" });
    expect(receiptAgain).toMatchObject({ ok: true, data: { replayed: true } });
    expect(await receiveShipmentReturn(returnId, [{ orderLineId: tableLine.id, receivedQuantity: 0 }])).toEqual({ ok: false, reason: "shipment_return_wrong_state" });
    expect(inspectionAgain).toMatchObject({ ok: true, data: { replayed: true, refund: { status: "succeeded" } } });
    expect(await inspectShipmentReturn(returnId, [{ orderLineId: tableLine.id, sellableQuantity: 0, damagedQuantity: 1 }])).toEqual({ ok: false, reason: "shipment_return_wrong_state" });
    const order = await adminOrder(orderId);
    expect(order.shipmentReturns).toHaveLength(1);
    expect(order.refunds).toHaveLength(1);
    expect((await movementsOf(tableVariantId)).filter((movement) => movement.kind.startsWith("shipment_return"))).toHaveLength(2);
    const kinds = (await mailOf(cookie)).map((message) => message.kind);
    expect(kinds.filter((kind) => kind === "shipment_return_declared")).toHaveLength(1);
    expect(kinds.filter((kind) => kind === "shipment_return_completed")).toHaveLength(1);
  });

  it("漏掉的通知：重送同一次登記與檢查會補回，且不重複", async () => {
    const { cookie, tableLine, table } = await shippedInBatches();
    const items = [{ orderLineId: tableLine.id, quantity: 1 }];
    const declared = await declareReturn(table, items, { returnKey: "key-mail" });
    const returnId = declared.ok ? declared.data.returnId : 0;
    await receiveShipmentReturn(returnId, [{ orderLineId: tableLine.id, receivedQuantity: 1 }]);
    await inspectShipmentReturn(returnId, [{ orderLineId: tableLine.id, sellableQuantity: 1, damagedQuantity: 0 }]);
    await env.DB.prepare("DELETE FROM mail_deliveries WHERE message_id IN (SELECT id FROM mail_messages WHERE kind LIKE 'shipment_return_%')").run();
    await env.DB.prepare("DELETE FROM mail_messages WHERE kind LIKE 'shipment_return_%'").run();
    expect((await mailOf(cookie)).filter((message) => message.kind.startsWith("shipment_return_"))).toEqual([]);

    await declareReturn(table, items, { returnKey: "key-mail" });
    await inspectShipmentReturn(returnId, [{ orderLineId: tableLine.id, sellableQuantity: 1, damagedQuantity: 0 }]);

    expect((await mailOf(cookie)).filter((message) => message.kind.startsWith("shipment_return_")).map((message) => message.kind).sort()).toEqual(["shipment_return_completed", "shipment_return_declared"]);
  });
});

describe("物流退回：權限與輸入", () => {
  it("沒有管理員身分被拒絕；顧客不能讀別人訂單的物流退回，也看不到管理員備註與操作人；輸入不合法被擋下", async () => {
    const { cookie, orderId, tableLine, table } = await shippedInBatches();
    const declared = await declareReturn(table, [{ orderLineId: tableLine.id, quantity: 1 }], { note: "內部查證" });
    const returnId = declared.ok ? declared.data.returnId : 0;
    const bob = await signInCustomer("bob");

    expect(await app.declareShipmentReturn("not-a-jwt", { shipmentId: table, returnKey: "k", items: [{ orderLineId: tableLine.id, quantity: 1 }] })).toEqual({ ok: false, reason: "unauthorized" });
    expect(await app.recordShipmentReturnReceipt("not-a-jwt", { returnId, items: [] })).toEqual({ ok: false, reason: "unauthorized" });
    expect(await app.recordShipmentReturnInspection("not-a-jwt", { returnId, items: [] })).toEqual({ ok: false, reason: "unauthorized" });
    expect(await app.getMyOrder(bob, { orderId })).toEqual({ ok: false, reason: "order_not_found" });
    const mine = await app.getMyOrder(cookie, { orderId });
    expect(mine.ok && mine.data.shipmentReturns.length === 1 && mine.data.shipmentReturns.every((entry) => !("note" in entry) && !("actor" in entry) && !("returnKey" in entry))).toBe(true);
    expect((await adminOrder(orderId)).shipmentReturns).toMatchObject([{ note: "內部查證", actor: "admin@example.com" }]);
    const jwt = await mintAccessJwt();
    expect(await app.declareShipmentReturn(jwt, { shipmentId: table, returnKey: "k", items: [] })).toMatchObject({ ok: false, reason: "invalid_input" });
    expect(await app.declareShipmentReturn(jwt, { shipmentId: table, returnKey: "bad key!", items: [{ orderLineId: 1, quantity: 1 }] })).toMatchObject({ ok: false, reason: "invalid_input" });
    expect(await app.declareShipmentReturn(jwt, { shipmentId: table, returnKey: "k", items: [{ orderLineId: 1, quantity: 0 }] })).toMatchObject({ ok: false, reason: "invalid_input" });
    expect(await app.recordShipmentReturnReceipt(jwt, { returnId: 999999, items: [{ orderLineId: 1, receivedQuantity: 1 }] })).toEqual({ ok: false, reason: "shipment_return_not_found" });
    expect(await app.recordShipmentReturnInspection(jwt, { returnId: 999999, items: [{ orderLineId: 1, sellableQuantity: 1, damagedQuantity: 0 }] })).toEqual({ ok: false, reason: "shipment_return_not_found" });
  });

  it("顧客檢視在收回並檢查完成後，仍不含管理員備註與操作人", async () => {
    const { cookie, orderId, mugLine, mugA } = await shippedInBatches();
    const returnId = await declareReturnOk(mugA, [{ orderLineId: mugLine.id, quantity: 1 }]);
    await receiveShipmentReturn(returnId, [{ orderLineId: mugLine.id, receivedQuantity: 1 }], "外箱破損");
    await inspectShipmentReturn(returnId, [{ orderLineId: mugLine.id, sellableQuantity: 1, damagedQuantity: 0 }], "品相良好");

    const mine = await app.getMyOrder(cookie, { orderId });

    expect(mine.ok && mine.data.shipmentReturns).toMatchObject([{ status: "completed" }]);
    const view = mine.ok ? mine.data.shipmentReturns[0]! : {};
    for (const key of ["note", "actor", "returnKey", "receivedBy", "inspectedBy", "receiptNote", "inspectionNote"]) expect(view, key).not.toHaveProperty(key);
    expect((await adminOrder(orderId)).shipmentReturns).toMatchObject([{ receivedBy: "admin@example.com", inspectedBy: "admin@example.com", receiptNote: "外箱破損", inspectionNote: "品相良好" }]);
  });

  it("只有尋回品的登記通知不承諾退款", async () => {
    const { cookie, mugLine, mugA } = await shippedInBatches();
    await confirmLossOk(mugA, [{ orderLineId: mugLine.id, quantity: 1 }]);
    await declareReturnOk(mugA, [{ orderLineId: mugLine.id, quantity: 0, foundLostQuantity: 1 }]);

    const body = await bodyOf(cookie, "shipment_return_declared");

    expect(body).not.toContain("檢查後會退款");
    expect(body).toContain("不會再退款");
  });

  it("收回與檢查要依序：退回中不能檢查，已收回不能再登記收回成別的數字", async () => {
    const { tableLine, table } = await shippedInBatches();
    const returnId = await declareReturnOk(table, [{ orderLineId: tableLine.id, quantity: 1 }]);

    expect(await inspectShipmentReturn(returnId, [{ orderLineId: tableLine.id, sellableQuantity: 1, damagedQuantity: 0 }])).toEqual({ ok: false, reason: "shipment_return_wrong_state" });
    expect(await receiveShipmentReturn(returnId, [{ orderLineId: 999999, receivedQuantity: 1 }])).toEqual({ ok: false, reason: "shipment_return_item_invalid" });
  });
});
