import { exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mintAccessJwt } from "./access";
import { approveOk, requestCancelOk } from "./cancellation-helpers";
import { resetDb } from "./db";
import { adminOrder } from "./shipment-helpers";
import { approveReturn, inspectReturn, receiveReturn, requestReturnOk, returnAllSellable, shippedMixedOrder, stockDetail } from "./return-helpers";

const app = exports.default;

// 每個測試都要建商品、走完付款與交運，全套並行時會比預設 5 秒慢（比照 cancellation-decide）
vi.setConfig({ testTimeout: 30_000 });

beforeEach(resetDb);

async function movements(variantId: number) {
  const result = await app.listStockMovements(await mintAccessJwt(), { variantId });
  if (!result.ok) throw new Error("讀取流水失敗");
  return result.data.items.reverse();
}

const kindsOf = async (cookie: string) => {
  const mail = await app.listMyMail(cookie);
  if (!mail.ok) throw new Error("讀信失敗");
  return mail.data.map((message) => message.kind);
};

describe("收回：收到實物才增加實體在庫與不可售", () => {
  it("核准不動庫存；收回後在庫與不可售同增、可售不變，流水記下訂單、申請與操作人；重送不重複入庫", async () => {
    const { cookie, orderId, mugVariantId, mugLine } = await shippedMixedOrder();
    const before = await stockDetail(mugVariantId);
    const requestId = await requestReturnOk(cookie, orderId, [{ orderLineId: mugLine.id, quantity: 2 }]);
    await approveReturn(requestId);
    expect(await stockDetail(mugVariantId)).toEqual(before);

    const received = await receiveReturn(requestId, [{ orderLineId: mugLine.id, receivedQuantity: 2 }], "外箱完好");

    expect(received).toEqual({ ok: true, data: { requestId, status: "received", replayed: false } });
    expect(await stockDetail(mugVariantId)).toEqual({ ...before, onHand: before.onHand + 2, unavailable: 2 });
    expect((await movements(mugVariantId)).at(-1)).toMatchObject({ kind: "return_received", delta: 2, onHandAfter: before.onHand + 2, unavailableDelta: 2, unavailableAfter: 2, orderId, returnRequestId: requestId, actor: "admin@example.com" });

    expect(await receiveReturn(requestId, [{ orderLineId: mugLine.id, receivedQuantity: 2 }])).toMatchObject({ ok: true, data: { replayed: true } });
    expect(await receiveReturn(requestId, [{ orderLineId: mugLine.id, receivedQuantity: 1 }])).toEqual({ ok: false, reason: "return_wrong_state" });
    expect((await stockDetail(mugVariantId)).onHand).toBe(before.onHand + 2);
    expect((await adminOrder(orderId)).returns).toMatchObject([{ status: "received", receivedBy: "admin@example.com", receiptNote: "外箱完好", items: [{ quantity: 2, receivedQuantity: 2 }] }]);
  });

  it("實收少於核准的數量：只入庫實收的，沒收到的釋出可再申請；一件都沒收到則結案、不動庫存", async () => {
    const { cookie, orderId, mugVariantId, mugLine } = await shippedMixedOrder();
    const before = await stockDetail(mugVariantId);
    const partial = await requestReturnOk(cookie, orderId, [{ orderLineId: mugLine.id, quantity: 2 }]);
    await approveReturn(partial);
    await receiveReturn(partial, [{ orderLineId: mugLine.id, receivedQuantity: 1 }]);
    expect(await stockDetail(mugVariantId)).toEqual({ ...before, onHand: before.onHand + 1, unavailable: 1 });
    // 已占用 1（收到的），可再退 2 中的 1：沒收到的那 1 釋出
    expect(await app.requestReturn(cookie, { orderId, requestKey: "again", items: [{ orderLineId: mugLine.id, quantity: 3 }] })).toEqual({ ok: false, reason: "return_quantity_exceeded" });
    const second = await requestReturnOk(cookie, orderId, [{ orderLineId: mugLine.id, quantity: 2 }]);
    await approveReturn(second);

    const none = await receiveReturn(second, [{ orderLineId: mugLine.id, receivedQuantity: 0 }]);

    expect(none).toMatchObject({ ok: true, data: { status: "not_received" } });
    expect(await stockDetail(mugVariantId)).toEqual({ ...before, onHand: before.onHand + 1, unavailable: 1 });
    expect(await inspectReturn(second, [])).toMatchObject({ ok: false, reason: "invalid_input" });
    expect(await inspectReturn(second, [{ orderLineId: mugLine.id, sellableQuantity: 0, damagedQuantity: 0 }])).toEqual({ ok: false, reason: "return_wrong_state" });
    expect(await requestReturnOk(cookie, orderId, [{ orderLineId: mugLine.id, quantity: 2 }])).toBeGreaterThan(second);
  });

  it("收回的限制：沒核准不能收、超過核准數量或明細對不上是 return_item_invalid", async () => {
    const { cookie, orderId, mugLine, tableLine } = await shippedMixedOrder();
    const requestId = await requestReturnOk(cookie, orderId, [{ orderLineId: mugLine.id, quantity: 1 }]);

    expect(await receiveReturn(requestId, [{ orderLineId: mugLine.id, receivedQuantity: 1 }])).toEqual({ ok: false, reason: "return_wrong_state" });
    await approveReturn(requestId);
    expect(await receiveReturn(requestId, [{ orderLineId: mugLine.id, receivedQuantity: 2 }])).toEqual({ ok: false, reason: "return_item_invalid" });
    expect(await receiveReturn(requestId, [{ orderLineId: tableLine.id, receivedQuantity: 1 }])).toEqual({ ok: false, reason: "return_item_invalid" });
    expect(await receiveReturn(requestId, [])).toMatchObject({ ok: false, reason: "invalid_input" });
    expect(await receiveReturn(9999, [{ orderLineId: mugLine.id, receivedQuantity: 1 }])).toEqual({ ok: false, reason: "return_not_found" });
  });
});

describe("檢查：良品轉可售、損壞品隔離、按原實付單價退款", () => {
  it("良品轉可售不改實體在庫，損壞品留在不可售；按實收數量與原實付單價退款（改價不影響）、運費不退，退款成功並通知", async () => {
    const { cookie, orderId, gateway, mugVariantId, mugLine } = await shippedMixedOrder();
    const before = await stockDetail(mugVariantId);
    const requestId = await requestReturnOk(cookie, orderId, [{ orderLineId: mugLine.id, quantity: 2 }]);
    await approveReturn(requestId);
    await receiveReturn(requestId, [{ orderLineId: mugLine.id, receivedQuantity: 2 }]);
    const { env } = await import("cloudflare:workers");
    await env.DB.prepare("UPDATE product_variants SET price_twd = 999 WHERE id = ?").bind(mugVariantId).run();

    const inspected = await inspectReturn(requestId, [{ orderLineId: mugLine.id, sellableQuantity: 1, damagedQuantity: 1 }], "杯口缺角");

    expect(inspected).toMatchObject({ ok: true, data: { requestId, replayed: false, refund: { status: "succeeded" } } });
    expect(await stockDetail(mugVariantId)).toEqual({ ...before, onHand: before.onHand + 2, unavailable: 1, available: before.available + 1 });
    expect((await movements(mugVariantId)).at(-1)).toMatchObject({ kind: "return_inspected", delta: 0, onHandAfter: before.onHand + 2, unavailableDelta: -1, unavailableAfter: 1, returnRequestId: requestId });
    const order = await adminOrder(orderId);
    expect(order.refunds).toMatchObject([{ reason: "return", amountTwd: 640, goodsTwd: 640, shippingTwd: 0, status: "succeeded" }]);
    expect(order.returns).toMatchObject([{ status: "completed", goodsTwd: 640, shippingTwd: 0, inspectedBy: "admin@example.com", inspectionNote: "杯口缺角", refund: { amountTwd: 640, status: "succeeded" }, items: [{ receivedQuantity: 2, sellableQuantity: 1, damagedQuantity: 1 }] }]);
    expect(order.lines.find((line) => line.id === mugLine.id)).toMatchObject({ returnedQuantity: 2, openReturnQuantity: 0 });
    expect(gateway.refundRequests).toMatchObject([{ amountTwd: 640 }]);
    expect(await kindsOf(cookie)).toEqual(expect.arrayContaining(["return_approved", "return_completed", "refund_succeeded"]));
  });

  it("全損壞時沒有轉可售的流水；重送同內容冪等（不重複轉換、不重複退款），不同內容是 return_wrong_state", async () => {
    const { cookie, orderId, gateway, mugVariantId, mugLine } = await shippedMixedOrder();
    const before = await stockDetail(mugVariantId);
    const requestId = await requestReturnOk(cookie, orderId, [{ orderLineId: mugLine.id, quantity: 1 }]);
    await approveReturn(requestId);
    await receiveReturn(requestId, [{ orderLineId: mugLine.id, receivedQuantity: 1 }]);
    const items = [{ orderLineId: mugLine.id, sellableQuantity: 0, damagedQuantity: 1 }];

    await inspectReturn(requestId, items);
    const replay = await inspectReturn(requestId, items);

    expect(replay).toMatchObject({ ok: true, data: { replayed: true, refund: { status: "succeeded" } } });
    expect(await inspectReturn(requestId, [{ orderLineId: mugLine.id, sellableQuantity: 1, damagedQuantity: 0 }])).toEqual({ ok: false, reason: "return_wrong_state" });
    expect(await stockDetail(mugVariantId)).toEqual({ ...before, onHand: before.onHand + 1, unavailable: 1 });
    expect((await movements(mugVariantId)).map((movement) => movement.kind)).toEqual(["adjustment", "dispatch", "return_received"]);
    expect(gateway.refundRequests).toHaveLength(1);
    expect((await kindsOf(cookie)).filter((kind) => kind === "return_completed")).toHaveLength(1);
  });

  it("多變體一起退：每個變體各自入庫與轉可售", async () => {
    const { cookie, orderId, mugVariantId, tableVariantId, mugLine, tableLine } = await shippedMixedOrder();
    const items = [{ orderLineId: mugLine.id, quantity: 3 }, { orderLineId: tableLine.id, quantity: 1 }];
    const mugBefore = await stockDetail(mugVariantId);
    const tableBefore = await stockDetail(tableVariantId);

    await returnAllSellable(cookie, orderId, items);

    expect(await stockDetail(mugVariantId)).toEqual({ ...mugBefore, onHand: mugBefore.onHand + 3, available: mugBefore.available + 3 });
    expect(await stockDetail(tableVariantId)).toEqual({ ...tableBefore, onHand: tableBefore.onHand + 1, available: tableBefore.available + 1 });
    expect((await movements(tableVariantId)).map((movement) => movement.kind)).toEqual(["adjustment", "dispatch", "return_received", "return_inspected"]);
  });

  it("檢查的限制：良品加損壞要等於實收、必須先收回、不屬於這案的明細被擋", async () => {
    const { cookie, orderId, mugLine, tableLine } = await shippedMixedOrder();
    const requestId = await requestReturnOk(cookie, orderId, [{ orderLineId: mugLine.id, quantity: 2 }]);
    await approveReturn(requestId);
    expect(await inspectReturn(requestId, [{ orderLineId: mugLine.id, sellableQuantity: 2, damagedQuantity: 0 }])).toEqual({ ok: false, reason: "return_wrong_state" });
    await receiveReturn(requestId, [{ orderLineId: mugLine.id, receivedQuantity: 2 }]);

    expect(await inspectReturn(requestId, [{ orderLineId: mugLine.id, sellableQuantity: 1, damagedQuantity: 0 }])).toEqual({ ok: false, reason: "return_item_invalid" });
    expect(await inspectReturn(requestId, [{ orderLineId: mugLine.id, sellableQuantity: 2, damagedQuantity: 1 }])).toEqual({ ok: false, reason: "return_item_invalid" });
    expect(await inspectReturn(requestId, [{ orderLineId: tableLine.id, sellableQuantity: 1, damagedQuantity: 0 }])).toEqual({ ok: false, reason: "return_item_invalid" });
    expect(await inspectReturn(requestId, [])).toMatchObject({ ok: false, reason: "invalid_input" });
    expect(await inspectReturn(9999, [{ orderLineId: mugLine.id, sellableQuantity: 1, damagedQuantity: 0 }])).toEqual({ ok: false, reason: "return_not_found" });
  });
});

describe("報廢：移出倉庫，同減實體在庫與不可售", () => {
  it("只能報廢已檢查確認的損壞品，待檢的退貨不能報廢；報廢後在庫與不可售同減、可售不變，原因與操作人進流水", async () => {
    const { cookie, orderId, mugVariantId, mugLine } = await shippedMixedOrder();
    const before = await stockDetail(mugVariantId);
    const requestId = await requestReturnOk(cookie, orderId, [{ orderLineId: mugLine.id, quantity: 3 }]);
    await approveReturn(requestId);
    await receiveReturn(requestId, [{ orderLineId: mugLine.id, receivedQuantity: 3 }]);
    const scrap = async (quantity: number) => app.scrapUnavailableStock(await mintAccessJwt(), { variantId: mugVariantId, quantity, reason: "損壞無法修復" });

    expect(await scrap(1)).toEqual({ ok: false, reason: "insufficient_unavailable" });
    await inspectReturn(requestId, [{ orderLineId: mugLine.id, sellableQuantity: 1, damagedQuantity: 2 }]);
    expect(await stockDetail(mugVariantId)).toEqual({ ...before, onHand: before.onHand + 3, unavailable: 2, available: before.available + 1 });
    expect(await scrap(3)).toEqual({ ok: false, reason: "insufficient_unavailable" });

    expect(await scrap(2)).toEqual({ ok: true, data: { onHand: before.onHand + 1, unavailable: 0 } });
    expect(await stockDetail(mugVariantId)).toEqual({ ...before, onHand: before.onHand + 1, unavailable: 0, available: before.available + 1 });
    expect((await movements(mugVariantId)).at(-1)).toMatchObject({ kind: "scrap", delta: -2, onHandAfter: before.onHand + 1, unavailableDelta: -2, unavailableAfter: 0, reason: "損壞無法修復", actor: "admin@example.com", orderId: null });
    expect(await scrap(1)).toEqual({ ok: false, reason: "insufficient_unavailable" });
  });

  it("輸入限制：原因必填、數量為正整數、變體要存在", async () => {
    const jwt = await mintAccessJwt();

    expect(await app.scrapUnavailableStock(jwt, { variantId: 1, quantity: 1, reason: "  " })).toMatchObject({ ok: false, reason: "invalid_input" });
    expect(await app.scrapUnavailableStock(jwt, { variantId: 1, quantity: 0, reason: "x" })).toMatchObject({ ok: false, reason: "invalid_input" });
    expect(await app.scrapUnavailableStock(jwt, { variantId: 999_999, quantity: 1, reason: "x" })).toEqual({ ok: false, reason: "variant_not_found" });
  });

  it("不可售不是可售：手動調減在庫不能吃掉不可售的數量", async () => {
    const { cookie, orderId, mugVariantId, mugLine } = await shippedMixedOrder();
    const before = await stockDetail(mugVariantId);
    const requestId = await requestReturnOk(cookie, orderId, [{ orderLineId: mugLine.id, quantity: 2 }]);
    await approveReturn(requestId);
    await receiveReturn(requestId, [{ orderLineId: mugLine.id, receivedQuantity: 2 }]);
    const adjust = async (delta: number) => app.adjustStock(await mintAccessJwt(), { variantId: mugVariantId, delta, reason: "盤損" });

    expect(await adjust(-(before.available + 1))).toEqual({ ok: false, reason: "insufficient_stock" });
    expect(await adjust(-before.available)).toMatchObject({ ok: true, data: { available: 0 } });
    expect(await stockDetail(mugVariantId)).toMatchObject({ unavailable: 2, available: 0 });
  });
});

describe("運費：同類全數退出才退原運費一次（取消與退貨混合）", () => {
  it("部分退貨不退運費；同類全部退貨完成才退該類原運費一次，另一類不受影響", async () => {
    const { cookie, orderId, mugLine, tableLine } = await shippedMixedOrder();

    const part = await returnAllSellable(cookie, orderId, [{ orderLineId: mugLine.id, quantity: 2 }]);
    expect(part.refund).toMatchObject({ status: "succeeded" });
    expect((await adminOrder(orderId)).refunds).toMatchObject([{ goodsTwd: 640, shippingTwd: 0 }]);

    await returnAllSellable(cookie, orderId, [{ orderLineId: mugLine.id, quantity: 1 }]);
    expect((await adminOrder(orderId)).refunds).toMatchObject([{ goodsTwd: 640, shippingTwd: 0 }, { goodsTwd: 320, shippingTwd: 100 }]);

    await returnAllSellable(cookie, orderId, [{ orderLineId: tableLine.id, quantity: 1 }]);
    const refunds = (await adminOrder(orderId)).refunds;
    expect(refunds[2]).toMatchObject({ reason: "return", goodsTwd: 6000, shippingTwd: 600 });
    expect(refunds.reduce((sum, refund) => sum + refund.amountTwd, 0)).toBe(7660);
  });

  it("已收回但尚未檢查的數量還不算退出：檢查完成當下才退運費", async () => {
    const { cookie, orderId, mugLine } = await shippedMixedOrder();
    const requestId = await requestReturnOk(cookie, orderId, [{ orderLineId: mugLine.id, quantity: 3 }]);
    await approveReturn(requestId);
    await receiveReturn(requestId, [{ orderLineId: mugLine.id, receivedQuantity: 3 }]);
    expect((await adminOrder(orderId)).refunds).toEqual([]);

    await inspectReturn(requestId, [{ orderLineId: mugLine.id, sellableQuantity: 3, damagedQuantity: 0 }]);

    expect((await adminOrder(orderId)).refunds).toMatchObject([{ goodsTwd: 960, shippingTwd: 100 }]);
  });
});

describe("取消與退貨混合（部分出貨）", () => {
  async function partlyShippedOrder() {
    const { paidMixedOrder } = await import("./cancellation-helpers");
    const { shipRemaining } = await import("./shipment-helpers");
    const order = await paidMixedOrder();
    // 馬克杯先交運 1 件，其餘 2 件與餐桌尚未交運
    const shipped = await shipRemaining(order.orderId, { items: [{ orderLineId: order.mugLine.id, quantity: 1 }] });
    if (!shipped.ok) throw new Error(`交運失敗：${shipped.reason}`);
    return order;
  }

  it("先完成退貨、後核准取消剩餘數量：運費在取消核准時退一次（同類全數退出）", async () => {
    const { cookie, orderId, mugLine } = await partlyShippedOrder();
    await returnAllSellable(cookie, orderId, [{ orderLineId: mugLine.id, quantity: 1 }]);
    expect((await adminOrder(orderId)).refunds).toMatchObject([{ reason: "return", goodsTwd: 320, shippingTwd: 0 }]);

    const cancelId = await requestCancelOk(cookie, orderId, [{ orderLineId: mugLine.id, quantity: 2 }]);
    await approveOk(cancelId);

    expect((await adminOrder(orderId)).refunds).toMatchObject([{ reason: "return", shippingTwd: 0 }, { reason: "cancellation", goodsTwd: 640, shippingTwd: 100 }]);
  });

  it("先核准取消、後完成退貨：運費在退貨完成時退一次，之後不會再退", async () => {
    const { cookie, orderId, mugLine } = await partlyShippedOrder();
    const cancelId = await requestCancelOk(cookie, orderId, [{ orderLineId: mugLine.id, quantity: 2 }]);
    await approveOk(cancelId);
    expect((await adminOrder(orderId)).refunds).toMatchObject([{ reason: "cancellation", goodsTwd: 640, shippingTwd: 0 }]);

    await returnAllSellable(cookie, orderId, [{ orderLineId: mugLine.id, quantity: 1 }]);

    const refunds = (await adminOrder(orderId)).refunds;
    expect(refunds).toMatchObject([{ reason: "cancellation", shippingTwd: 0 }, { reason: "return", goodsTwd: 320, shippingTwd: 100 }]);
    expect(refunds.reduce((sum, refund) => sum + refund.shippingTwd, 0)).toBe(100);
  });

  it("退貨申請與取消申請不重複占用：已交運的走退貨、未交運的走取消，各自的上限互不侵占", async () => {
    const { cookie, orderId, mugLine } = await partlyShippedOrder();
    const { requestCancel } = await import("./cancellation-helpers");
    const { requestReturn } = await import("./return-helpers");

    expect(await requestCancel(cookie, orderId, [{ orderLineId: mugLine.id, quantity: 3 }])).toEqual({ ok: false, reason: "cancellation_quantity_exceeded" });
    expect(await requestReturn(cookie, orderId, [{ orderLineId: mugLine.id, quantity: 2 }])).toEqual({ ok: false, reason: "return_quantity_exceeded" });
    expect(await requestCancel(cookie, orderId, [{ orderLineId: mugLine.id, quantity: 2 }])).toMatchObject({ ok: true });
    expect(await requestReturn(cookie, orderId, [{ orderLineId: mugLine.id, quantity: 1 }])).toMatchObject({ ok: true });
  });
});
