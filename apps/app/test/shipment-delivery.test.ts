import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { generateRogueKey, mintAccessJwt } from "./access";
import { setNow } from "./clock";
import { signInCustomer } from "./customers";
import { forceOrderStatus, resetDb } from "./db";
import { orderOf, placeMugOrder, stockOf } from "./payment-helpers";
import { adminOrder, adminShipment, reportShipmentEvent, shipBatch } from "./shipment-helpers";

const app = exports.default;

// 全套並行時建商品、下單會比預設 5 秒慢（比照 admin-ship）
vi.setConfig({ testTimeout: 30_000 });

const MINUTE = 60_000;
let cookie: string;
let orderId: number;
let variantId: number;

// 重 fixture 只建一次：一張數量充足的已付款訂單，每個測試各自交運一個新批次來承接事件
beforeAll(async () => {
  await resetDb();
  cookie = await signInCustomer("alice");
  ({ orderId, variantId } = await placeMugOrder(cookie, { onHand: 100, quantity: 40 }));
  await forceOrderStatus(orderId, "paid");
});

/** 新的一批，並把「現在」推到交運後 3 小時，回傳批次編號與以交運時間為基準的時間函式（分鐘）。 */
async function freshBatch() {
  const shipmentId = await shipBatch(orderId, 1);
  const { shippedAt } = await adminShipment(orderId, shipmentId);
  const at = (minutes: number) => shippedAt! + minutes * MINUTE;
  setNow(at(180));
  return { shipmentId, at };
}

const noticesFor = async (kind: string, shipmentId: number) => {
  const { results } = await env.DB.prepare("SELECT id, event_key AS eventKey FROM mail_messages WHERE kind = ? AND (event_key = ? OR event_key LIKE ?)").bind(kind, `${kind}:${shipmentId}`, `${kind}:%`).all<{ id: number; eventKey: string }>();
  return results;
};
const deliveredNotices = (shipmentId: number) => noticesFor("shipment_delivered", shipmentId).then((rows) => rows.filter((row) => row.eventKey === `shipment_delivered:${shipmentId}`));

describe("送達與配送進度", () => {
  it("新交運的批次是運送中、沒有送達時間；回報送達後逐批記下實際送達時間，其他批不受影響", async () => {
    const { shipmentId, at } = await freshBatch();
    const other = await shipBatch(orderId, 1);
    expect(await adminShipment(orderId, shipmentId)).toMatchObject({ deliveryStatus: "in_transit", deliveredAt: null, events: [] });

    const result = await reportShipmentEvent(shipmentId, "evt-delivered-1", "delivered", at(60));

    expect(result).toEqual({ ok: true, data: { shipmentId, deliveryStatus: "delivered", deliveredAt: at(60), replayed: false } });
    expect(await adminShipment(orderId, shipmentId)).toMatchObject({ deliveryStatus: "delivered", deliveredAt: at(60) });
    expect(await adminShipment(orderId, other)).toMatchObject({ deliveryStatus: "in_transit", deliveredAt: null });
    expect((await orderOf(cookie, orderId)).shipments.find((shipment) => shipment.id === shipmentId)).toMatchObject({ deliveryStatus: "delivered", deliveredAt: at(60) });
  });

  it("送達同 batch 寫一封送達通知（一批一封）；同鍵重送與另一個鍵的重複送達回報都不再寄", async () => {
    const { shipmentId, at } = await freshBatch();

    await reportShipmentEvent(shipmentId, "evt-a", "delivered", at(60));
    const replay = await reportShipmentEvent(shipmentId, "evt-a", "delivered", at(60));
    await reportShipmentEvent(shipmentId, "evt-b", "delivered", at(90));

    expect(replay).toMatchObject({ ok: true, data: { replayed: true } });
    expect(await deliveredNotices(shipmentId)).toHaveLength(1);
    expect((await adminShipment(orderId, shipmentId)).events).toHaveLength(2);
  });

  it("多筆送達回報以發生最早的一筆為實際送達時間，不論到達順序", async () => {
    const { shipmentId, at } = await freshBatch();

    await reportShipmentEvent(shipmentId, "evt-late", "delivered", at(90));
    await reportShipmentEvent(shipmentId, "evt-early", "delivered", at(60));

    expect(await adminShipment(orderId, shipmentId)).toMatchObject({ deliveryStatus: "delivered", deliveredAt: at(60) });
  });
});

describe("暫時配送失敗與再次配送", () => {
  it("失敗後再次配送再送達：同一批原貨，不新增出貨數量、不扣庫、不退款，批次數不變", async () => {
    const { shipmentId, at } = await freshBatch();
    const before = { stock: await stockOf(variantId), order: await adminOrder(orderId) };

    await reportShipmentEvent(shipmentId, "evt-1", "delivery_failed", at(30));
    expect(await adminShipment(orderId, shipmentId)).toMatchObject({ deliveryStatus: "delivery_failed", deliveredAt: null });
    await reportShipmentEvent(shipmentId, "evt-2", "redelivery", at(60));
    expect(await adminShipment(orderId, shipmentId)).toMatchObject({ deliveryStatus: "in_transit", deliveredAt: null });
    await reportShipmentEvent(shipmentId, "evt-3", "delivered", at(90));

    const after = await adminOrder(orderId);
    expect(await adminShipment(orderId, shipmentId)).toMatchObject({ deliveryStatus: "delivered", deliveredAt: at(90) });
    expect(await stockOf(variantId)).toEqual(before.stock);
    expect(after.shipments).toHaveLength(before.order.shipments.length);
    expect(after.lines[0]!.shippedQuantity).toBe(before.order.lines[0]!.shippedQuantity);
    expect(after.payments.map((payment) => payment.refundReason)).toEqual(before.order.payments.map((payment) => payment.refundReason));
    expect(after.status).toBe(before.order.status);
  });

  it("每次配送失敗寫一封配送異常通知（以回報為單位，同鍵重送不重複）；再次配送不寄信", async () => {
    const { shipmentId, at } = await freshBatch();
    const count = async () => (await env.DB.prepare("SELECT count(*) AS n FROM mail_messages WHERE kind = 'shipment_delivery_failed'").first<{ n: number }>())!.n;
    const start = await count();

    await reportShipmentEvent(shipmentId, "evt-1", "delivery_failed", at(30));
    await reportShipmentEvent(shipmentId, "evt-1", "delivery_failed", at(30));
    await reportShipmentEvent(shipmentId, "evt-2", "redelivery", at(60));
    await reportShipmentEvent(shipmentId, "evt-3", "delivery_failed", at(90));

    expect(await count()).toBe(start + 2);
    const failureNotice = await env.DB.prepare("SELECT subject, body FROM mail_messages WHERE kind = 'shipment_delivery_failed' ORDER BY id DESC").first<{ subject: string; body: string }>();
    expect(failureNotice!.subject).toContain(`訂單 #${orderId}`);
  });

  it("管理員在信件清單看得到配送異常通知，並可重送", async () => {
    const { shipmentId, at } = await freshBatch();
    await reportShipmentEvent(shipmentId, "evt-1", "delivery_failed", at(30));
    const jwt = await mintAccessJwt();

    const listed = await app.listMailForAdmin(jwt);
    const message = listed.ok ? listed.data.messages.find((candidate) => candidate.kind === "shipment_delivery_failed") : undefined;

    expect(message).toBeDefined();
    expect(await app.resendMail(jwt, { messageId: message!.id })).toMatchObject({ ok: true });
  });
});

describe("延遲、重送、亂序與通知遺失", () => {
  it("送達已確定後才到的較早失敗回報只留紀錄：仍是已送達、送達時間不變，也不寄配送異常通知", async () => {
    const { shipmentId, at } = await freshBatch();
    const failures = async () => (await env.DB.prepare("SELECT count(*) AS n FROM mail_messages WHERE kind = 'shipment_delivery_failed'").first<{ n: number }>())!.n;
    await reportShipmentEvent(shipmentId, "evt-delivered", "delivered", at(90));
    const start = await failures();

    const late = await reportShipmentEvent(shipmentId, "evt-failed", "delivery_failed", at(30));
    const afterwards = await reportShipmentEvent(shipmentId, "evt-redelivery", "redelivery", at(120));

    expect(late).toMatchObject({ ok: true, data: { deliveryStatus: "delivered", deliveredAt: at(90) } });
    expect(afterwards).toMatchObject({ ok: true, data: { deliveryStatus: "delivered", deliveredAt: at(90) } });
    expect(await failures()).toBe(start);
    expect((await adminShipment(orderId, shipmentId)).events.map((event) => event.kind).sort()).toEqual(["delivered", "delivery_failed", "redelivery"]);
  });

  it("再次配送先到、較早的失敗後到：以發生時間最新的回報為準，仍是運送中（不被亂序打回失敗）", async () => {
    const { shipmentId, at } = await freshBatch();

    await reportShipmentEvent(shipmentId, "evt-redelivery", "redelivery", at(60));
    await reportShipmentEvent(shipmentId, "evt-failed", "delivery_failed", at(30));

    expect(await adminShipment(orderId, shipmentId)).toMatchObject({ deliveryStatus: "in_transit" });
  });

  it("失敗回報遺失時，再次配送與送達回報仍可記錄：不偽造也不卡住", async () => {
    const { shipmentId, at } = await freshBatch();

    expect(await reportShipmentEvent(shipmentId, "evt-redelivery", "redelivery", at(60))).toMatchObject({ ok: true, data: { deliveryStatus: "in_transit" } });
    expect(await reportShipmentEvent(shipmentId, "evt-delivered", "delivered", at(90))).toMatchObject({ ok: true, data: { deliveryStatus: "delivered" } });
  });

  it("同一事件鍵帶不同內容回 event_key_conflict，既有紀錄不動", async () => {
    const { shipmentId, at } = await freshBatch();
    await reportShipmentEvent(shipmentId, "evt-1", "delivered", at(60));

    expect(await reportShipmentEvent(shipmentId, "evt-1", "delivery_failed", at(60))).toEqual({ ok: false, reason: "event_key_conflict" });
    expect(await reportShipmentEvent(shipmentId, "evt-1", "delivered", at(70))).toEqual({ ok: false, reason: "event_key_conflict" });
    expect(await adminShipment(orderId, shipmentId)).toMatchObject({ deliveryStatus: "delivered", deliveredAt: at(60) });
  });

  it("發生時間早於交運或晚於現在的回報被拒絕，不改進度", async () => {
    const { shipmentId, at } = await freshBatch();

    expect(await reportShipmentEvent(shipmentId, "evt-early", "delivered", at(-1))).toEqual({ ok: false, reason: "event_time_invalid" });
    expect(await reportShipmentEvent(shipmentId, "evt-future", "delivered", at(180 + 24 * 60))).toEqual({ ok: false, reason: "event_time_invalid" });
    expect(await adminShipment(orderId, shipmentId)).toMatchObject({ deliveryStatus: "in_transit", deliveredAt: null, events: [] });
  });

  it("不存在的批次回 shipment_not_found", async () => {
    expect(await reportShipmentEvent(999_999, "evt-1", "delivered", Date.now())).toEqual({ ok: false, reason: "shipment_not_found" });
  });

  it("通知遺失可查證及補齊：事件列出對應通知，信遺失（noticeMessageId 為 null）後以同一事件重送會補回，且不產生第二封", async () => {
    const { shipmentId, at } = await freshBatch();
    await reportShipmentEvent(shipmentId, "evt-delivered", "delivered", at(60));
    expect((await adminShipment(orderId, shipmentId)).events).toMatchObject([{ eventKey: "evt-delivered", kind: "delivered", occurredAt: at(60), noticeMessageId: expect.any(Number) }]);

    await env.DB.prepare("DELETE FROM mail_deliveries WHERE message_id IN (SELECT id FROM mail_messages WHERE event_key = ?)").bind(`shipment_delivered:${shipmentId}`).run();
    await env.DB.prepare("DELETE FROM mail_messages WHERE event_key = ?").bind(`shipment_delivered:${shipmentId}`).run();
    expect((await adminShipment(orderId, shipmentId)).events).toMatchObject([{ noticeMessageId: null }]);

    const replay = await reportShipmentEvent(shipmentId, "evt-delivered", "delivered", at(60));
    await reportShipmentEvent(shipmentId, "evt-delivered", "delivered", at(60));

    expect(replay).toMatchObject({ ok: true, data: { replayed: true } });
    expect(await deliveredNotices(shipmentId)).toHaveLength(1);
    expect((await adminShipment(orderId, shipmentId)).events).toMatchObject([{ noticeMessageId: expect.any(Number) }]);
  });
});

describe("權限", () => {
  it("沒有有效 Access JWT 回 unauthorized，批次不動；顧客讀不到別人的批次送達狀態", async () => {
    const { shipmentId, at } = await freshBatch();
    const rogue = await mintAccessJwt({ key: await generateRogueKey() });
    const input = { shipmentId, eventKey: "evt-1", kind: "delivered", occurredAt: at(60) };

    expect(await app.recordShipmentEvent("", input)).toEqual({ ok: false, reason: "unauthorized" });
    expect(await app.recordShipmentEvent(rogue, input)).toEqual({ ok: false, reason: "unauthorized" });
    expect(await adminShipment(orderId, shipmentId)).toMatchObject({ deliveryStatus: "in_transit" });
    const bob = await signInCustomer("bob");
    expect(await app.getMyOrder(bob, { orderId })).toEqual({ ok: false, reason: "order_not_found" });
  });

  it.each([
    [{ eventKey: "bad key!" }],
    [{ kind: "lost" }],
    [{ occurredAt: -1 }],
    [{ shipmentId: 0 }],
  ])("輸入無效（%j）回 invalid_input", async (override) => {
    const result = await app.recordShipmentEvent(await mintAccessJwt(), { shipmentId: 1, eventKey: "evt-1", kind: "delivered", occurredAt: Date.now(), ...override });
    expect(result).toMatchObject({ ok: false, reason: "invalid_input" });
  });
});
