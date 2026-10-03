import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { setNow } from "./clock";
import { signInCustomer } from "./customers";
import { forceOrderStatus, resetDb } from "./db";
import { orderOf, placeMugOrder } from "./payment-helpers";
import { adminShipment, reportShipmentEvent, shipBatch } from "./shipment-helpers";
import { approveReturn, decideReturn, requestReturn } from "./return-helpers";

const app = exports.default;

// 全套並行時建商品、下單會比預設 5 秒慢（比照 return-request）
vi.setConfig({ testTimeout: 30_000 });

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const TAIPEI_OFFSET = 8 * HOUR;
/** 台北日曆日的 00:00（UTC epoch 毫秒）。 */
const taipeiMidnight = (time: number) => Math.floor((time + TAIPEI_OFFSET) / DAY) * DAY - TAIPEI_OFFSET;

/** 測試會把時鐘往後推好幾天，登入階段不能因此過期；把所有階段的到期時間拉到很遠。 */
const keepSessionsAlive = () => env.DB.prepare("UPDATE session SET expires_at = ?").bind(Date.UTC(2100, 0, 1)).run();

let cookie: string;
let orderId: number;
let lineId: number;

// 重 fixture 只建一次：數量充足的已付款訂單，每個測試各自交運新批次。
// 高水位時鐘只增不減，所以測試依序把時間往後推（批次的交運時間就是當時的有效時間，送達日從它往後算）。
beforeAll(async () => {
  await resetDb();
  cookie = await signInCustomer("alice");
  await keepSessionsAlive();
  const placed = await placeMugOrder(cookie, { onHand: 400, quantity: 90 });
  orderId = placed.orderId;
  await forceOrderStatus(orderId, "paid");
  lineId = (await orderOf(cookie, orderId)).lines[0]!.id;
});

/** 交運一批（`quantity` 件）。 */
async function shipped(quantity = 10) {
  const shipmentId = await shipBatch(orderId, quantity);
  const { shippedAt } = await adminShipment(orderId, shipmentId);
  // 送達日從交運的隔天（台北）起算，之後的時間點都以它為基準
  return { shipmentId, day0: taipeiMidnight(shippedAt!) + DAY };
}

/** 交運並在送達日（台北）上午 10 點送達，現在時間停在送達當下。 */
async function delivered(quantity = 10, deliveryDay = 0) {
  const { shipmentId, day0 } = await shipped(quantity);
  const deliveredAt = day0 + deliveryDay * DAY + 10 * HOUR;
  setNow(deliveredAt);
  const reported = await reportShipmentEvent(shipmentId, `delivered-${deliveredAt}`, "delivered", deliveredAt);
  if (!reported.ok) throw new Error(`回報送達失敗：${reported.reason}`);
  return { shipmentId, day0, deliveredAt };
}

const selfService = (shipmentId: number, quantity = 1, extra: Record<string, unknown> = {}) =>
  requestReturn(cookie, orderId, [{ orderLineId: lineId, shipmentId, quantity }], extra);

const batchOf = async (shipmentId: number) => (await orderOf(cookie, orderId)).returnBatches.find((batch) => batch.shipmentId === shipmentId)!;

describe("自助退貨窗口（逐批，送達日隔日起算 7 天，台北日曆日）", () => {
  it("邊界：送達當日可申請、第 7 天 23:59:59 可申請、第 8 天 00:00:00 關閉；關閉後人工受理入口仍可申請", async () => {
    const { shipmentId, day0 } = await delivered();

    expect(await selfService(shipmentId)).toMatchObject({ ok: true });

    setNow(day0 + 7 * DAY + 23 * HOUR + 59 * 60_000 + 59_000);
    expect(await batchOf(shipmentId)).toMatchObject({ state: "open", windowEndsAt: day0 + 8 * DAY });
    expect(await selfService(shipmentId)).toMatchObject({ ok: true });

    setNow(day0 + 8 * DAY);
    expect(await batchOf(shipmentId)).toMatchObject({ state: "closed", windowEndsAt: day0 + 8 * DAY, items: [{ selfServiceQuantity: 0 }] });
    expect(await selfService(shipmentId)).toEqual({ ok: false, reason: "return_window_closed" });

    // 期限外不擋人工受理：同一明細不帶批次，仍可申請並進入審核
    const manual = await requestReturn(cookie, orderId, [{ orderLineId: lineId, quantity: 1 }], { reason: "瑕疵，已過期限" });
    expect(manual).toMatchObject({ ok: true });
    expect((await orderOf(cookie, orderId)).returns.find((request) => request.id === (manual.ok ? manual.data.requestId : 0))).toMatchObject({ selfService: false, status: "pending" });
  });

  it("窗口以台北日曆日為準：送達日晚上 23:30 送達，第 7 天結束（隔日起算）就關閉，不是送達後滿 168 小時", async () => {
    const { shipmentId, day0 } = await shipped();
    const deliveredAt = day0 + 23 * HOUR + 30 * 60_000;
    setNow(deliveredAt);
    await reportShipmentEvent(shipmentId, "late-night", "delivered", deliveredAt);

    setNow(day0 + 8 * DAY - 1);
    expect(await selfService(shipmentId)).toMatchObject({ ok: true });
    setNow(day0 + 8 * DAY);
    expect(await selfService(shipmentId)).toEqual({ ok: false, reason: "return_window_closed" });
  });

  it("未送達的批次不可自助申請（含配送失敗中）；沒有可靠送達日的批次同樣不開放，保留人工受理且不補假日期", async () => {
    const { shipmentId, day0 } = await shipped();
    setNow(day0 + DAY);
    expect(await selfService(shipmentId)).toEqual({ ok: false, reason: "shipment_not_delivered" });
    await reportShipmentEvent(shipmentId, "failed-1", "delivery_failed", day0 + HOUR);
    expect(await selfService(shipmentId)).toEqual({ ok: false, reason: "shipment_not_delivered" });
    expect(await batchOf(shipmentId)).toMatchObject({ state: "not_delivered", deliveredAt: null, windowEndsAt: null, items: [{ selfServiceQuantity: 0 }] });

    // 遷移補建的舊批次：狀態是已送達但沒有送達日
    await env.DB.prepare("UPDATE shipments SET delivery_status = 'delivered', delivered_at = NULL WHERE id = ?").bind(shipmentId).run();
    expect(await selfService(shipmentId)).toEqual({ ok: false, reason: "shipment_not_delivered" });
    expect(await batchOf(shipmentId)).toMatchObject({ state: "not_delivered", windowEndsAt: null });
    expect(await requestReturn(cookie, orderId, [{ orderLineId: lineId, quantity: 1 }])).toMatchObject({ ok: true });
  });

  it("同一張訂單不同批各有各的期限：舊批過期、新批仍可自助申請", async () => {
    const early = await delivered();
    const late = await delivered(10, 5);
    // 現在停在 late 窗口的最後一刻；early 比 late 早交運、早送達，窗口早已關閉
    setNow(taipeiMidnight(late.deliveredAt) + 8 * DAY - 1);
    expect(await batchOf(late.shipmentId)).toMatchObject({ state: "open" });
    expect(await batchOf(early.shipmentId)).toMatchObject({ state: "closed" });

    expect(await selfService(early.shipmentId)).toEqual({ ok: false, reason: "return_window_closed" });
    expect(await selfService(late.shipmentId)).toMatchObject({ ok: true });
  });

  it("送達時間被較早的回報改寫：期限隨之提前，已成立的申請不受影響", async () => {
    const { shipmentId, day0 } = await delivered(10, 1);
    const first = await selfService(shipmentId);
    setNow(day0 + 8 * DAY + 12 * HOUR);
    expect(await batchOf(shipmentId)).toMatchObject({ state: "open", windowEndsAt: day0 + 9 * DAY });

    const earlier = await reportShipmentEvent(shipmentId, "earlier", "delivered", day0 + 10 * HOUR);
    expect(earlier).toMatchObject({ ok: true, data: { deliveredAt: day0 + 10 * HOUR } });

    expect(await batchOf(shipmentId)).toMatchObject({ state: "closed", windowEndsAt: day0 + 8 * DAY });
    expect(await selfService(shipmentId)).toEqual({ ok: false, reason: "return_window_closed" });
    expect((await orderOf(cookie, orderId)).returns.find((request) => first.ok && request.id === first.data.requestId)).toMatchObject({ status: "pending", selfService: true });
  });
});

describe("自助申請的數量與重複", () => {
  it("數量以該批為上限：同一批超量、跨批湊數都被擋；每批各自計算並寫入批次對應", async () => {
    const a = await delivered(3);
    const b = await delivered(2, 1);

    expect(await selfService(a.shipmentId, 4)).toEqual({ ok: false, reason: "return_quantity_exceeded" });
    expect(await selfService(a.shipmentId, 3)).toMatchObject({ ok: true });
    expect(await selfService(a.shipmentId, 1)).toEqual({ ok: false, reason: "return_quantity_exceeded" });

    const both = await requestReturn(cookie, orderId, [
      { orderLineId: lineId, shipmentId: b.shipmentId, quantity: 2 },
    ]);
    expect(both).toMatchObject({ ok: true });
    expect((await batchOf(a.shipmentId)).items[0]!.selfServiceQuantity).toBe(0);
    expect((await batchOf(b.shipmentId)).items[0]!.selfServiceQuantity).toBe(0);
    const rows = (await env.DB.prepare("SELECT shipment_id AS shipmentId, quantity FROM return_request_batches ORDER BY id DESC LIMIT 2").all()).results;
    expect(rows).toEqual([{ shipmentId: b.shipmentId, quantity: 2 }, { shipmentId: a.shipmentId, quantity: 3 }]);
  });

  it("一次申請跨兩批：明細申請數量是各批加總，其中一批逾期則整筆不成立", async () => {
    const a = await delivered(2);
    const b = await delivered(2, 1);
    const items = [
      { orderLineId: lineId, shipmentId: a.shipmentId, quantity: 2 },
      { orderLineId: lineId, shipmentId: b.shipmentId, quantity: 1 },
    ];

    const requested = await requestReturn(cookie, orderId, items);
    expect(requested).toMatchObject({ ok: true });
    const mine = (await orderOf(cookie, orderId)).returns.find((request) => requested.ok && request.id === requested.data.requestId);
    expect(mine).toMatchObject({ selfService: true, items: [{ orderLineId: lineId, quantity: 3 }] });

    const c = await delivered(2);
    setNow(taipeiMidnight(c.deliveredAt) + 8 * DAY);
    const d = await delivered(2, 9);
    const mixed = await requestReturn(cookie, orderId, [
      { orderLineId: lineId, shipmentId: c.shipmentId, quantity: 1 },
      { orderLineId: lineId, shipmentId: d.shipmentId, quantity: 1 },
    ]);
    expect(mixed).toEqual({ ok: false, reason: "return_window_closed" });
    expect((await batchOf(d.shipmentId)).items[0]!.selfServiceQuantity).toBe(2);
  });

  it("明細層的占用仍有效：人工受理占用的數量讓自助可申請數量變少；拒絕後釋出批次與明細的占用", async () => {
    const { shipmentId } = await delivered(2);
    const heldBefore = (await orderOf(cookie, orderId)).lines[0]!;
    const available = heldBefore.shippedQuantity - heldBefore.openReturnQuantity - heldBefore.returnedQuantity;
    expect(available).toBeGreaterThanOrEqual(2);
    // 人工受理占用到只剩 1 件可退（明細層）
    const manual = await requestReturn(cookie, orderId, [{ orderLineId: lineId, quantity: available - 1 }]);
    expect(manual).toMatchObject({ ok: true });

    expect((await batchOf(shipmentId)).items[0]!.selfServiceQuantity).toBe(1);
    expect(await selfService(shipmentId, 2)).toEqual({ ok: false, reason: "return_quantity_exceeded" });
    const first = await selfService(shipmentId, 1);
    expect(first).toMatchObject({ ok: true });

    await decideReturn(first.ok ? first.data.requestId : 0, "reject");
    expect((await batchOf(shipmentId)).items[0]!.selfServiceQuantity).toBe(1);
    await decideReturn(manual.ok ? manual.data.requestId : 0, "reject");
  });

  it("同鍵重送回原申請且不重複占用；同鍵不同內容衝突；窗口關閉後同鍵重送仍回原申請", async () => {
    const { shipmentId, day0 } = await delivered(5);
    const request = { orderId, requestKey: "self-1", items: [{ orderLineId: lineId, shipmentId, quantity: 2 }], reason: "尺寸不合" };

    const first = await app.requestReturn(cookie, request);
    expect(first).toMatchObject({ ok: true, data: { replayed: false } });
    expect(await app.requestReturn(cookie, request)).toEqual({ ok: true, data: { requestId: first.ok ? first.data.requestId : 0, replayed: true } });
    expect((await batchOf(shipmentId)).items[0]!.selfServiceQuantity).toBe(3);
    expect(await app.requestReturn(cookie, { ...request, items: [{ orderLineId: lineId, shipmentId, quantity: 1 }] })).toEqual({ ok: false, reason: "request_key_conflict" });
    // 同樣的數量改走人工（不帶批次）是不同內容
    expect(await app.requestReturn(cookie, { ...request, items: [{ orderLineId: lineId, quantity: 2 }] })).toEqual({ ok: false, reason: "request_key_conflict" });

    setNow(day0 + 9 * DAY);
    expect(await app.requestReturn(cookie, request)).toMatchObject({ ok: true, data: { replayed: true } });
    expect(await env.DB.prepare("SELECT count(*) AS n FROM return_request_batches WHERE shipment_id = ?").bind(shipmentId).first<{ n: number }>()).toEqual({ n: 1 });
  });

  it("並行自助申請同一批數量只有一個成立", async () => {
    const { shipmentId } = await delivered(4);
    const results = await Promise.all([1, 2, 3].map(() => selfService(shipmentId, 4)));
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, reason: "return_quantity_exceeded" }, { ok: false, reason: "return_quantity_exceeded" }]);
  });

  it("核准後走既有收回檢查退款流程（自助申請與人工申請同一條）", async () => {
    const { shipmentId } = await delivered(2);
    const requested = await selfService(shipmentId, 1);
    if (!requested.ok) throw new Error("申請失敗");
    await approveReturn(requested.data.requestId);
    expect((await orderOf(cookie, orderId)).returns.find((request) => request.id === requested.data.requestId)).toMatchObject({ status: "approved", selfService: true });
  });
});

describe("批次與權限檢查", () => {
  it("批次不存在、屬於別張訂單、或不含該明細：return_batch_invalid；別人的訂單一律 order_not_found；自助與人工不可混在同一次提交", async () => {
    const bob = await signInCustomer("bob");
    await keepSessionsAlive();
    const other = await placeMugOrder(bob, { onHand: 10, quantity: 2 });
    await forceOrderStatus(other.orderId, "paid");
    const otherShipment = await shipBatch(other.orderId, 1);

    expect(await selfService(otherShipment)).toEqual({ ok: false, reason: "return_batch_invalid" });
    expect(await selfService(999_999)).toEqual({ ok: false, reason: "return_batch_invalid" });

    const { shipmentId } = await delivered(1);
    expect(await app.requestReturn(bob, { orderId, requestKey: "x", items: [{ orderLineId: lineId, shipmentId, quantity: 1 }] })).toEqual({ ok: false, reason: "order_not_found" });
    expect(await app.getMyOrder(bob, { orderId })).toEqual({ ok: false, reason: "order_not_found" });
    expect(await app.requestReturn(cookie, { orderId, requestKey: "y", items: [{ orderLineId: lineId, shipmentId, quantity: 1 }, { orderLineId: lineId, quantity: 1 }] })).toMatchObject({ ok: false, reason: "invalid_input" });
    expect(await app.requestReturn(cookie, { orderId, requestKey: "z", items: [{ orderLineId: lineId, shipmentId, quantity: 1 }, { orderLineId: lineId, shipmentId, quantity: 1 }] })).toMatchObject({ ok: false, reason: "invalid_input" });
    // 別人的批次不會因為帶了別人的批次編號而洩漏狀態：自己的訂單看不到別人的批次
    expect((await orderOf(cookie, orderId)).returnBatches.some((batch) => batch.shipmentId === otherShipment)).toBe(false);
  });
});
