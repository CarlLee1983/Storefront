import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateRogueKey, mintAccessJwt } from "./access";
import { checkoutInput, createStockedListing, newKey } from "./checkout-helpers";
import { signInCustomer } from "./customers";
import { forceOrderStatus, resetDb } from "./db";
import { orderOf, placeMugOrder, stockOf } from "./payment-helpers";
import { adminOrder, APPOINTMENT, shipRemaining } from "./shipment-helpers";

const app = exports.default;

// 每個測試都要建商品、上傳圖片與下單，全套並行時會比預設 5 秒慢（比照 ba457e3）
vi.setConfig({ testTimeout: 30_000 });

/** 成立一張已付款的訂單，回傳顧客 cookie、訂單編號與變體編號。 */
async function paidOrder(name = "alice", options?: { onHand?: number; quantity?: number }) {
  const cookie = await signInCustomer(name);
  const { orderId, variantId } = await placeMugOrder(cookie, options);
  await forceOrderStatus(orderId, "paid");
  return { cookie, orderId, variantId };
}

/** 馬克杯（一般）與餐桌（大型）各一筆明細的已付款訂單。 */
async function paidMixedOrder() {
  const cookie = await signInCustomer("alice");
  const mug = await createStockedListing("馬克杯", 320, 10);
  const table = await createStockedListing("餐桌", 6000, 5, "large");
  const placed = await app.checkout(cookie, checkoutInput([
    { variantId: mug.variantId, quantity: 2, seenUnitPriceTwd: 320 },
    { variantId: table.variantId, quantity: 1, seenUnitPriceTwd: 6000 },
  ], newKey(), 700));
  if (!placed.ok) throw new Error(`結帳失敗：${placed.reason}`);
  await forceOrderStatus(placed.data.orderId, "paid");
  const order = await adminOrder(placed.data.orderId);
  return { cookie, orderId: placed.data.orderId, mugLine: order.lines.find((line) => line.variantId === mug.variantId)!, tableLine: order.lines.find((line) => line.variantId === table.variantId)!, mug, table };
}

describe("管理員交運（整批）", () => {
  beforeEach(resetDb);

  it("已付款的訂單附物流單號交運全部數量：轉為已出貨，批次記下物流單號（trim）、明細數量與交運時間", async () => {
    const { orderId } = await paidOrder();

    const shipped = await shipRemaining(orderId, { trackingNumber: "  TW123456789  " });

    expect(shipped).toEqual({ ok: true, data: { orderId, shipmentId: expect.any(Number), status: "shipped", replayed: false } });
    expect(await adminOrder(orderId)).toMatchObject({
      status: "shipped",
      lines: [{ quantity: 2, shippedQuantity: 2 }],
      shipments: [{ trackingNumber: "TW123456789", appointment: null, shippedAt: expect.any(Number), items: [{ productName: "馬克杯", quantity: 2, deliveryType: "standard" }] }],
    });
  });

  it("不附物流單號也能交運：省略、空字串、只有空白都記為沒有物流單號", async () => {
    for (const extra of [{}, { trackingNumber: "" }, { trackingNumber: "   " }]) {
      const { orderId } = await paidOrder();
      expect(await shipRemaining(orderId, extra)).toMatchObject({ ok: true });
      expect((await adminOrder(orderId)).shipments).toMatchObject([{ trackingNumber: null }]);
    }
  });

  it("物流單號超過長度上限回 invalid_input，訂單不動", async () => {
    const { orderId } = await paidOrder();

    const result = await shipRemaining(orderId, { trackingNumber: "X".repeat(101) });

    expect(result).toMatchObject({ ok: false, reason: "invalid_input", fields: { trackingNumber: [expect.any(String)] } });
    expect(await adminOrder(orderId)).toMatchObject({ status: "paid", shipments: [] });
  });

  it.each(["TW\n123", "TW\t123", "TW\u0000123", "單號123"])("物流單號含控制字元或非 ASCII（%j）回 invalid_input，訂單不動", async (trackingNumber) => {
    const { orderId } = await paidOrder();

    const result = await shipRemaining(orderId, { trackingNumber });

    expect(result).toMatchObject({ ok: false, reason: "invalid_input", fields: { trackingNumber: [expect.any(String)] } });
    expect(await adminOrder(orderId)).toMatchObject({ status: "paid", shipments: [] });
  });

  it("物流單號可含空格與常見符號（可列印 ASCII）", async () => {
    const { orderId } = await paidOrder();

    await shipRemaining(orderId, { trackingNumber: "TW-123_456/AB 7" });

    expect((await adminOrder(orderId)).shipments).toMatchObject([{ trackingNumber: "TW-123_456/AB 7" }]);
  });

  it("待付款、已逾期、已取消的訂單不能交運：order_not_shippable，狀態不變", async () => {
    const cookie = await signInCustomer("alice");
    const { orderId } = await placeMugOrder(cookie);

    for (const status of ["pending_payment", "expired", "cancelled"]) {
      await forceOrderStatus(orderId, status);
      expect(await shipRemaining(orderId)).toEqual({ ok: false, reason: "order_not_shippable" });
      expect(await adminOrder(orderId)).toMatchObject({ status, shipments: [] });
    }
  });


  it("已出貨的訂單不能再交運、不能撤回：order_not_shippable，批次不變", async () => {
    const { orderId } = await paidOrder();
    await shipRemaining(orderId, { trackingNumber: "FIRST" });
    const before = await adminOrder(orderId);
    const [line] = before.lines;

    expect(await shipRemaining(orderId, { items: [{ orderLineId: line!.id, quantity: 1 }], trackingNumber: "SECOND" })).toEqual({ ok: false, reason: "order_not_shippable" });

    expect(await adminOrder(orderId)).toEqual(before);
  });

  it("訂單不存在回 order_not_found；輸入無效回 invalid_input", async () => {
    const jwt = await mintAccessJwt();
    const valid = { dispatchKey: newKey(), items: [{ orderLineId: 1, quantity: 1 }] };

    expect(await app.shipOrder(jwt, { orderId: 999, ...valid })).toEqual({ ok: false, reason: "order_not_found" });
    expect(await app.shipOrder(jwt, { orderId: 0, ...valid })).toMatchObject({ ok: false, reason: "invalid_input" });
    expect(await app.shipOrder(jwt, { orderId: 1, dispatchKey: "bad key!", items: valid.items })).toMatchObject({ ok: false, reason: "invalid_input", fields: { dispatchKey: [expect.any(String)] } });
    expect(await app.shipOrder(jwt, { orderId: 1, dispatchKey: newKey(), items: [] })).toMatchObject({ ok: false, reason: "invalid_input", fields: { items: [expect.any(String)] } });
    expect(await app.shipOrder(jwt, { orderId: 1, dispatchKey: newKey(), items: [{ orderLineId: 1, quantity: 0 }] })).toMatchObject({ ok: false, reason: "invalid_input" });
    expect(await app.shipOrder(jwt, { orderId: 1, dispatchKey: newKey(), items: [{ orderLineId: 1, quantity: 1 }, { orderLineId: 1, quantity: 1 }] })).toMatchObject({ ok: false, reason: "invalid_input" });
  });

  it("沒有有效 Access JWT 被拒絕為 unauthorized，訂單不動", async () => {
    const { orderId } = await paidOrder();
    const rogue = await mintAccessJwt({ key: await generateRogueKey() });
    const unauthorized = { ok: false, reason: "unauthorized" };
    const input = { orderId, dispatchKey: newKey(), items: [{ orderLineId: 1, quantity: 1 }] };

    expect(await app.shipOrder("", input)).toEqual(unauthorized);
    expect(await app.shipOrder(rogue, input)).toEqual(unauthorized);
    expect(await app.getOrderForAdmin("", { orderId })).toEqual(unauthorized);
    expect(await app.listOrdersForAdmin("", {})).toEqual(unauthorized);

    expect(await adminOrder(orderId)).toMatchObject({ status: "paid", shipments: [] });
  });
});

describe("分批交運（ADR 0006）", () => {
  beforeEach(resetDb);

  it("每批只扣該批數量的實體在庫並消耗對應的已付款保留：可售數量不變，狀態先部分出貨、出完才已出貨，運費與總額不變", async () => {
    const { cookie, orderId, variantId } = await paidOrder("alice", { onHand: 10, quantity: 3 });
    const before = await orderOf(cookie, orderId);
    const [line] = (await adminOrder(orderId)).lines;
    expect(await stockOf(variantId)).toEqual({ onHand: 10, available: 7 });

    const first = await shipRemaining(orderId, { items: [{ orderLineId: line!.id, quantity: 1 }], trackingNumber: "BATCH-1" });

    expect(first).toMatchObject({ ok: true, data: { status: "partially_shipped" } });
    expect(await stockOf(variantId)).toEqual({ onHand: 9, available: 7 });
    expect(await adminOrder(orderId)).toMatchObject({ status: "partially_shipped", lines: [{ quantity: 3, shippedQuantity: 1 }] });

    const second = await shipRemaining(orderId, { trackingNumber: "BATCH-2" });

    expect(second).toMatchObject({ ok: true, data: { status: "shipped" } });
    expect(await stockOf(variantId)).toEqual({ onHand: 7, available: 7 });
    const after = await orderOf(cookie, orderId);
    expect(after).toMatchObject({ status: "shipped", totalTwd: before.totalTwd, shippingFees: before.shippingFees });
    expect(after.shipments.map(({ trackingNumber, items }) => ({ trackingNumber, quantities: items.map((item) => item.quantity) }))).toEqual([
      { trackingNumber: "BATCH-1", quantities: [1] },
      { trackingNumber: "BATCH-2", quantities: [2] },
    ]);
    const movements = await app.listStockMovements(await mintAccessJwt(), { orderId });
    expect(movements.ok && movements.data.items.filter((item) => item.kind === "dispatch").map((item) => item.delta).sort()).toEqual([-1, -2]);
  });

  it("部分出貨的訂單仍保留未交運的數量：庫存調整不能把可售降到負數", async () => {
    const { orderId, variantId } = await paidOrder("alice", { onHand: 10, quantity: 3 });
    const [line] = (await adminOrder(orderId)).lines;
    await shipRemaining(orderId, { items: [{ orderLineId: line!.id, quantity: 1 }] });

    const jwt = await mintAccessJwt();
    expect(await app.adjustStock(jwt, { variantId, delta: -8, reason: "盤損" })).toEqual({ ok: false, reason: "insufficient_stock" });
    expect(await app.adjustStock(jwt, { variantId, delta: -7, reason: "盤損" })).toMatchObject({ ok: true, data: { onHand: 2, available: 0 } });
  });

  it("數量超過未交運數量被擋下：shipment_quantity_exceeded，整批不成立（多明細時其他明細也不扣庫）", async () => {
    const { orderId, mugLine, tableLine, mug, table } = await paidMixedOrder();

    const result = await shipRemaining(orderId, { items: [{ orderLineId: mugLine.id, quantity: 1 }, { orderLineId: tableLine.id, quantity: 2 }], appointment: APPOINTMENT });

    expect(result).toEqual({ ok: false, reason: "shipment_quantity_exceeded" });
    expect(await stockOf(mug.variantId)).toEqual({ onHand: 10, available: 8 });
    expect(await stockOf(table.variantId)).toEqual({ onHand: 5, available: 4 });
    expect(await adminOrder(orderId)).toMatchObject({ status: "paid", shipments: [] });
  });

  it("已交運的數量不能再交運：同一明細累計不超過明細數量", async () => {
    const { orderId, variantId } = await paidOrder("alice", { onHand: 10, quantity: 3 });
    const [line] = (await adminOrder(orderId)).lines;
    await shipRemaining(orderId, { items: [{ orderLineId: line!.id, quantity: 2 }] });

    expect(await shipRemaining(orderId, { items: [{ orderLineId: line!.id, quantity: 2 }] })).toEqual({ ok: false, reason: "shipment_quantity_exceeded" });

    expect(await stockOf(variantId)).toEqual({ onHand: 8, available: 7 });
  });

  it("別張訂單的明細或不存在的明細：shipment_line_invalid", async () => {
    const { orderId } = await paidOrder("alice");
    const other = await paidOrder("bob");
    const [otherLine] = (await adminOrder(other.orderId)).lines;

    expect(await shipRemaining(orderId, { items: [{ orderLineId: otherLine!.id, quantity: 1 }] })).toEqual({ ok: false, reason: "shipment_line_invalid" });
    expect(await shipRemaining(orderId, { items: [{ orderLineId: 999999, quantity: 1 }] })).toEqual({ ok: false, reason: "shipment_line_invalid" });
  });

  it("同一冪等鍵重送回原批次：不重複扣庫、不寫第二筆流水、不再寄第二封信", async () => {
    const { cookie, orderId, variantId } = await paidOrder("alice", { onHand: 10, quantity: 3 });
    const [line] = (await adminOrder(orderId)).lines;
    const input = { orderId, dispatchKey: "resubmit-0001", items: [{ orderLineId: line!.id, quantity: 1 }] };
    const jwt = await mintAccessJwt();

    const first = await app.shipOrder(jwt, input);
    const again = await app.shipOrder(jwt, input);

    expect(first).toMatchObject({ ok: true, data: { replayed: false } });
    expect(again).toMatchObject({ ok: true, data: { shipmentId: first.ok ? first.data.shipmentId : -1, replayed: true } });
    expect(await stockOf(variantId)).toEqual({ onHand: 9, available: 7 });
    expect((await adminOrder(orderId)).shipments).toHaveLength(1);
    const mail = await app.listMyMail(cookie);
    expect(mail.ok && mail.data.filter((message) => message.kind === "shipment_dispatched")).toHaveLength(1);
  });

  it("並行交運同一張訂單的全部數量（不同冪等鍵）：只有一次成功，只扣一次庫、只寫一批", async () => {
    const { orderId, variantId } = await paidOrder("alice", { onHand: 10, quantity: 2 });
    const [line] = (await adminOrder(orderId)).lines;
    const jwt = await mintAccessJwt();
    const ship = (trackingNumber: string) => app.shipOrder(jwt, { orderId, dispatchKey: newKey(), items: [{ orderLineId: line!.id, quantity: 2 }], trackingNumber });

    const results = await Promise.all([ship("A"), ship("B"), ship("C")]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok).every((result) => !result.ok && result.reason === "order_not_shippable")).toBe(true);
    expect(await stockOf(variantId)).toEqual({ onHand: 8, available: 8 });
    const winner = results.findIndex((result) => result.ok);
    expect((await adminOrder(orderId)).shipments).toMatchObject([{ trackingNumber: ["A", "B", "C"][winner] }]);
  });

  it("並行交運各一件而合計超過未交運數量（3 件單，各要 2 件）：只成功一批，另一批 shipment_quantity_exceeded", async () => {
    const { orderId, variantId } = await paidOrder("alice", { onHand: 10, quantity: 3 });
    const [line] = (await adminOrder(orderId)).lines;
    const jwt = await mintAccessJwt();
    const ship = () => app.shipOrder(jwt, { orderId, dispatchKey: newKey(), items: [{ orderLineId: line!.id, quantity: 2 }] });

    const results = await Promise.all([ship(), ship()]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, reason: "shipment_quantity_exceeded" }]);
    expect(await stockOf(variantId)).toEqual({ onHand: 8, available: 7 });
  });
});

describe("大型配送預約", () => {
  beforeEach(resetDb);

  it("含大型配送明細的批次必須帶議定時段：缺少回 appointment_required，訂單不動", async () => {
    const { orderId, tableLine } = await paidMixedOrder();

    expect(await shipRemaining(orderId, { items: [{ orderLineId: tableLine.id, quantity: 1 }], appointment: undefined })).toEqual({ ok: false, reason: "appointment_required" });

    expect(await adminOrder(orderId)).toMatchObject({ status: "paid", shipments: [] });
  });

  it("只含一般宅配的批次不可帶時段：appointment_not_applicable", async () => {
    const { orderId, mugLine } = await paidMixedOrder();

    expect(await shipRemaining(orderId, { items: [{ orderLineId: mugLine.id, quantity: 2 }], appointment: APPOINTMENT })).toEqual({ ok: false, reason: "appointment_not_applicable" });
  });

  it("時段結束不晚於開始回 invalid_input", async () => {
    const { orderId, tableLine } = await paidMixedOrder();

    const result = await shipRemaining(orderId, { items: [{ orderLineId: tableLine.id, quantity: 1 }], appointment: { start: APPOINTMENT.end, end: APPOINTMENT.start } });

    expect(result).toMatchObject({ ok: false, reason: "invalid_input", fields: { appointment: [expect.any(String)] } });
  });

  it("一般與大型各自一批：大型批記議定時段，顧客與管理員都看得到各批明細、配送類型與時段；分批不追加運費", async () => {
    const { cookie, orderId, mugLine, tableLine, mug, table } = await paidMixedOrder();
    const before = await orderOf(cookie, orderId);

    await shipRemaining(orderId, { items: [{ orderLineId: mugLine.id, quantity: 2 }], trackingNumber: "STD-1" });
    const large = await shipRemaining(orderId, { items: [{ orderLineId: tableLine.id, quantity: 1 }], appointment: APPOINTMENT, trackingNumber: "LRG-1" });

    expect(large).toMatchObject({ ok: true, data: { status: "shipped" } });
    const view = await orderOf(cookie, orderId);
    expect(view).toMatchObject({ status: "shipped", totalTwd: before.totalTwd, shippingFees: before.shippingFees });
    expect(view.shipments).toMatchObject([
      { trackingNumber: "STD-1", appointment: null, items: [{ productName: "馬克杯", quantity: 2, deliveryType: "standard" }] },
      { trackingNumber: "LRG-1", appointment: APPOINTMENT, items: [{ productName: "餐桌", quantity: 1, deliveryType: "large" }] },
    ]);
    expect(await stockOf(mug.variantId)).toEqual({ onHand: 8, available: 8 });
    expect(await stockOf(table.variantId)).toEqual({ onHand: 4, available: 4 });
  });
});

describe("出貨通知與顧客可見範圍", () => {
  beforeEach(resetDb);

  it("每批交運在同一個 batch 寫一封出貨通知（商品數量、物流單號、議定時段），顧客可在信箱讀到", async () => {
    const { cookie, orderId, tableLine } = await paidMixedOrder();

    await shipRemaining(orderId, { items: [{ orderLineId: tableLine.id, quantity: 1 }], appointment: APPOINTMENT, trackingNumber: "LRG-1" });

    const list = await app.listMyMail(cookie);
    const notice = list.ok ? list.data.find((message) => message.kind === "shipment_dispatched") : undefined;
    expect(notice).toBeDefined();
    const opened = await app.getMyMail(cookie, { messageId: notice!.id });
    expect(opened).toMatchObject({ ok: true, data: { body: expect.stringContaining("餐桌 × 1") } });
    expect(opened).toMatchObject({ ok: true, data: { body: expect.stringContaining("LRG-1") } });
    expect(opened).toMatchObject({ ok: true, data: { body: expect.stringContaining("2026-10-10 09:00 至 2026-10-10 12:00") } });
  });

  it("顧客只看得到自己訂單的批次，我的訂單清單同樣帶批次", async () => {
    const alice = await paidOrder("alice");
    const bob = await paidOrder("bob");
    await shipRemaining(alice.orderId, { trackingNumber: "TW999" });

    expect(await app.getMyOrder(bob.cookie, { orderId: alice.orderId })).toEqual({ ok: false, reason: "order_not_found" });
    const listed = await app.listMyOrders(alice.cookie);
    expect(listed.ok && listed.data[0]).toMatchObject({ id: alice.orderId, status: "shipped", shipments: [{ trackingNumber: "TW999" }] });
    expect(await orderOf(bob.cookie, bob.orderId)).toMatchObject({ status: "paid", shipments: [] });
  });
});

describe("交運的保護邊界", () => {
  beforeEach(resetDb);

  it("同一冪等鍵帶不同內容回 dispatch_key_conflict：不建立第二批、不重複扣庫；內容相同（明細順序不同）仍視為重送", async () => {
    const { orderId, variantId } = await paidOrder("alice", { onHand: 10, quantity: 3 });
    const [line] = (await adminOrder(orderId)).lines;
    const jwt = await mintAccessJwt();
    const base = { orderId, dispatchKey: "conflict-0001", items: [{ orderLineId: line!.id, quantity: 1 }], trackingNumber: "A" };
    await app.shipOrder(jwt, base);

    expect(await app.shipOrder(jwt, { ...base, items: [{ orderLineId: line!.id, quantity: 2 }] })).toEqual({ ok: false, reason: "dispatch_key_conflict" });
    expect(await app.shipOrder(jwt, { ...base, trackingNumber: "B" })).toEqual({ ok: false, reason: "dispatch_key_conflict" });
    expect(await app.shipOrder(jwt, base)).toMatchObject({ ok: true, data: { replayed: true } });

    expect((await adminOrder(orderId)).shipments).toHaveLength(1);
    expect(await stockOf(variantId)).toEqual({ onHand: 9, available: 7 });
  });

  it("同鍵重送已出完的訂單仍回原批次：不是 order_not_shippable，不重複扣庫", async () => {
    const { orderId, variantId } = await paidOrder("alice", { onHand: 10, quantity: 2 });
    const [line] = (await adminOrder(orderId)).lines;
    const input = { orderId, dispatchKey: "replay-done-0001", items: [{ orderLineId: line!.id, quantity: 2 }] };
    const jwt = await mintAccessJwt();
    const first = await app.shipOrder(jwt, input);
    expect(first).toMatchObject({ ok: true, data: { status: "shipped" } });

    const again = await app.shipOrder(jwt, input);

    expect(again).toMatchObject({ ok: true, data: { shipmentId: first.ok ? first.data.shipmentId : -1, status: "shipped", replayed: true } });
    expect(await stockOf(variantId)).toEqual({ onHand: 8, available: 8 });
    expect((await adminOrder(orderId)).shipments).toHaveLength(1);
  });

  it("同一冪等鍵並行提交：只建一批、只扣一次庫、只寫一組流水", async () => {
    const { orderId, variantId } = await paidOrder("alice", { onHand: 10, quantity: 3 });
    const [line] = (await adminOrder(orderId)).lines;
    const jwt = await mintAccessJwt();
    const input = { orderId, dispatchKey: "parallel-same-key", items: [{ orderLineId: line!.id, quantity: 1 }] };

    const results = await Promise.all([app.shipOrder(jwt, input), app.shipOrder(jwt, input), app.shipOrder(jwt, input)]);

    expect(results.every((result) => result.ok)).toBe(true);
    expect(results.filter((result) => result.ok && !result.data.replayed)).toHaveLength(1);
    expect(await stockOf(variantId)).toEqual({ onHand: 9, available: 7 });
    expect((await adminOrder(orderId)).shipments).toHaveLength(1);
    const movements = await app.listStockMovements(jwt, { orderId });
    expect(movements.ok && movements.data.items.filter((item) => item.kind === "dispatch")).toHaveLength(1);
  });

  it("遷移補建的舊批次不會被重送扣庫或寄信：舊鍵 legacy 對已出完的舊單被擋，遷移鍵 legacy:0021 輸入驗證不接受", async () => {
    const { cookie, orderId, variantId } = await paidOrder("alice", { onHand: 10, quantity: 3 });
    const [line] = (await adminOrder(orderId)).lines;
    // 模擬 0021 補建的舊批次（沒有內容指紋、沒有流水），訂單已出完
    await env.DB.batch([
      env.DB.prepare("INSERT INTO shipments (id, order_id, dispatch_key, tracking_number, actor) VALUES (900, ?, 'legacy:0021', 'OLD', 'system:0021_shipments')").bind(orderId),
      env.DB.prepare("INSERT INTO shipment_items (shipment_id, order_line_id, quantity) VALUES (900, ?, 3)").bind(line!.id),
      env.DB.prepare("UPDATE orders SET status = 'shipped' WHERE id = ?").bind(orderId),
    ]);
    const before = await stockOf(variantId);
    const mailBefore = await app.listMyMail(cookie);
    const jwt = await mintAccessJwt();
    const items = [{ orderLineId: line!.id, quantity: 3 }];

    expect(await app.shipOrder(jwt, { orderId, dispatchKey: "legacy", items })).toEqual({ ok: false, reason: "order_not_shippable" });
    expect(await app.shipOrder(jwt, { orderId, dispatchKey: "legacy:0021", items })).toMatchObject({ ok: false, reason: "invalid_input", fields: { dispatchKey: [expect.any(String)] } });

    expect(await stockOf(variantId)).toEqual(before);
    const movements = await app.listStockMovements(jwt, { orderId });
    expect(movements.ok && movements.data.items.filter((item) => item.kind === "dispatch")).toEqual([]);
    expect(await app.listMyMail(cookie)).toEqual(mailBefore);
    expect((await adminOrder(orderId)).shipments).toMatchObject([{ id: 900, trackingNumber: "OLD" }]);
  });

  it("pending_payment／expired／cancelled／shipped 的訂單即使輸入缺時段也先回 order_not_shippable", async () => {
    const { orderId, tableLine } = await paidMixedOrder();

    for (const status of ["pending_payment", "expired", "cancelled", "shipped"]) {
      await forceOrderStatus(orderId, status);
      expect(await shipRemaining(orderId, { items: [{ orderLineId: tableLine.id, quantity: 1 }] })).toEqual({ ok: false, reason: "order_not_shippable" });
    }
  });

});
