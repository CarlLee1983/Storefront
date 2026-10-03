import { env, exports } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import { buildCustomerTimeline, type TimelineSource } from "../src/orders/timeline";
import { selectTimelineFacts } from "../src/orders/timeline-facts";
import { mintAccessJwt } from "./access";
import { approveOk, paidMixedOrder, requestCancelOk } from "./cancellation-helpers";
import { setNow } from "./clock";
import { resetDb } from "./db";
import { confirmLossOk, shipItems } from "./loss-helpers";
import { orderOf, placeMugOrder, startPaymentFor } from "./payment-helpers";
import { installFakeGateway } from "./fake-gateway";
import { signInCustomer } from "./customers";
import { approveReturn, inspectReturn, receiveReturn, requestReturn } from "./return-helpers";
import { returnAllSellable as shipmentReturnAllSellable } from "./shipment-return-helpers";

import { adminOrder, adminShipment, reportShipmentEvent } from "./shipment-helpers";

const app = exports.default;
const MINUTE = 60_000;

beforeEach(resetDb);

const kindsOf = (timeline: { events: { kind: string }[] }) => timeline.events.map((event) => event.kind);

/**
 * 一張同時有多種進度的訂單：馬克杯 3 件（320）、餐桌 1 件（6000，大型配送）、運費 700。
 * 開立發票明確失敗（待補）；馬克杯 2 件為第一批並已送達；其餘 1 件馬克杯取消、核准時退款明確失敗；餐桌為第二批、配送失敗。
 */
async function multiProgressOrder() {
  const order = await paidMixedOrder("alice", { beforePayment: (gateway) => gateway.failNextInvoiceExplicitly() });
  const { orderId, cookie, mugLine, tableLine, gateway } = order;
  const batchA = await shipItems(orderId, [{ orderLineId: mugLine.id, quantity: 2 }]);
  const { shippedAt } = await adminShipment(orderId, batchA);
  setNow(shippedAt! + 180 * MINUTE);
  expect(await reportShipmentEvent(batchA, "evt-a-delivered", "delivered", shippedAt! + 60 * MINUTE)).toMatchObject({ ok: true });
  const requestId = await requestCancelOk(cookie, orderId, [{ orderLineId: mugLine.id, quantity: 1 }]);
  gateway.failNextRefundExplicitly();
  await approveOk(requestId);
  const batchB = await shipItems(orderId, [{ orderLineId: tableLine.id, quantity: 1 }], true);
  const { shippedAt: shippedB } = await adminShipment(orderId, batchB);
  setNow(shippedB! + 180 * MINUTE);
  expect(await reportShipmentEvent(batchB, "evt-b-failed", "delivery_failed", shippedB! + 30 * MINUTE)).toMatchObject({ ok: true });
  return { ...order, batchA, batchB };
}

describe("多種進度同時呈現", () => {
  it("部分送達、部分取消、配送失敗、退款失敗與發票待補並存，不以單一狀態覆蓋；顧客看不到退款失敗與結果不明的區別", async () => {
    const { cookie, orderId } = await multiProgressOrder();

    const admin = (await adminOrder(orderId)).timeline;
    const customer = (await orderOf(cookie, orderId)).timeline;

    expect(admin.progress.flags).toEqual(["partially_delivered", "delivery_failed", "partially_cancelled", "refund_open", "refund_failed", "invoice_pending"]);
    expect(customer.progress.flags).toEqual(["partially_delivered", "delivery_failed", "partially_cancelled", "refund_open", "invoice_pending"]);
    for (const timeline of [admin, customer]) expect(new Set(timeline.events.map((event) => event.id)).size).toBe(timeline.events.length);
    expect(admin.progress.quantities).toEqual({ ordered: 4, dispatched: 3, delivered: 2, cancelled: 1, pendingCancellation: 0, returned: 0, openReturn: 0, lost: 0, shipmentReturned: 0, awaitingDispatch: 0 });
  });

  it("部分送達與待出貨也各自成立：只出一批並送達，其餘仍待出貨", async () => {
    const { cookie, orderId, mugLine } = await paidMixedOrder();
    const batch = await shipItems(orderId, [{ orderLineId: mugLine.id, quantity: 1 }]);
    const { shippedAt } = await adminShipment(orderId, batch);
    setNow(shippedAt! + 180 * MINUTE);
    await reportShipmentEvent(batch, "evt-1", "delivered", shippedAt! + 60 * MINUTE);

    expect((await orderOf(cookie, orderId)).timeline.progress.flags).toEqual(["awaiting_dispatch", "partially_delivered"]);
  });
});

describe("可對帳", () => {
  it("時間線的數量與款項合計，等於各域畫面（明細、退款、發票折讓、付款）的加總", async () => {
    const { cookie, orderId, gateway } = await multiProgressOrder();
    gateway.failNextAllowanceExplicitly();
    const refundId = (await adminOrder(orderId)).refunds[0]!.id;
    expect(await app.retryRefund(await mintAccessJwt(), { refundId })).toMatchObject({ ok: true });

    for (const detail of [await adminOrder(orderId), await orderOf(cookie, orderId)]) {
      const { quantities, money } = detail.timeline.progress;
      const sum = (pick: (line: (typeof detail.lines)[number]) => number) => detail.lines.reduce((total, line) => total + pick(line), 0);
      expect(quantities).toMatchObject({
        ordered: sum((line) => line.quantity),
        dispatched: sum((line) => line.shippedQuantity),
        cancelled: sum((line) => line.cancelledQuantity),
        returned: sum((line) => line.returnedQuantity),
        lost: sum((line) => line.lostQuantity),
      });
      expect(money.paidTwd).toBe(detail.payments.filter((payment) => payment.status === "succeeded").reduce((total, payment) => total + payment.amountTwd, 0));
      expect(money.refundedTwd).toBe(detail.refunds.filter((refund) => refund.status === "succeeded").reduce((total, refund) => total + refund.amountTwd, 0));
      expect(money.refundedTwd).toBe(320);
      // 折讓待補：發票檢視的待折讓合計與時間線一致；折讓事件的金額合計等於已折讓
      expect(money.allowancePendingTwd).toBe(detail.invoices.reduce((total, invoice) => total + invoice.pendingAllowanceTwd, 0));
      expect(money.allowedTwd).toBe(detail.invoices.reduce((total, invoice) => total + invoice.allowedTwd, 0));
      expect(detail.timeline.events.filter((event) => event.kind === "allowance_issued").reduce((total, event) => total + (event.amountTwd ?? 0), 0)).toBe(money.allowedTwd);
      expect(detail.timeline.events.filter((event) => event.kind === "refund_succeeded").reduce((total, event) => total + (event.amountTwd ?? 0), 0)).toBe(money.refundedTwd);
    }
  });
});

describe("技術重試不冒充新事件", () => {
  it("退款失敗後多次重試與補辦發票，各筆業務事實仍各一個事件；顧客時間線沒有退款失敗", async () => {
    const { cookie, orderId, gateway } = await multiProgressOrder();
    const refundId = (await adminOrder(orderId)).refunds[0]!.id;
    gateway.failNextRefundExplicitly();
    expect(await app.retryRefund(await mintAccessJwt(), { refundId })).toMatchObject({ ok: true });
    expect(await app.retryRefund(await mintAccessJwt(), { refundId })).toMatchObject({ ok: true });
    const invoiceId = (await adminOrder(orderId)).invoices[0]!.id;
    gateway.failNextInvoiceExplicitly();
    await app.retryInvoice(await mintAccessJwt(), { invoiceId });
    await app.retryInvoice(await mintAccessJwt(), { invoiceId });

    const admin = await adminOrder(orderId);
    expect(admin.refunds[0]!.attempts.length).toBeGreaterThanOrEqual(3);
    const count = (timeline: { events: { kind: string }[] }, kind: string) => timeline.events.filter((event) => event.kind === kind).length;
    expect(count(admin.timeline, "refund_registered")).toBe(1);
    expect(count(admin.timeline, "refund_failed")).toBe(1);
    expect(count(admin.timeline, "refund_succeeded")).toBe(1);
    expect(count(admin.timeline, "invoice_issued")).toBe(1);
    const customer = (await orderOf(cookie, orderId)).timeline;
    expect(kindsOf(customer)).not.toContain("refund_failed");
    expect(count(customer, "refund_succeeded")).toBe(1);
  });
});

describe("顧客與管理員視角", () => {
  it("顧客時間線不含操作人、技術嘗試、備註與冪等鍵，也沒有待辦入口；管理員有操作人與連到本單的待辦", async () => {
    const { cookie, orderId } = await multiProgressOrder();
    await app.addOrderNote(await mintAccessJwt(), { orderId, body: "內部備註：顧客很急" });

    const customer = (await orderOf(cookie, orderId)).timeline;
    const serialized = JSON.stringify(customer);
    for (const secret of ["admin@example.com", "actor", "attempts", "備註", "rf_", "inv_", "alw_", "todos", "href"]) expect(serialized).not.toContain(secret);
    expect(customer).not.toHaveProperty("todos");

    const admin = (await adminOrder(orderId)).timeline;
    expect(admin.events.find((event) => event.kind === "cancellation_approved")).toMatchObject({ actor: "admin@example.com" });
    expect(admin.todos).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "refund_handle", href: `/admin/orders/${orderId}#refunds` }),
      expect.objectContaining({ kind: "invoice_handle", href: `/admin/orders/${orderId}#invoices` }),
      expect.objectContaining({ kind: "delivery_failed", href: `/admin/orders/${orderId}#shipments` }),
    ]));
  });

  it("別人的訂單讀不到時間線；沒有管理員身分被拒絕", async () => {
    const { orderId } = await multiProgressOrder();
    const other = await signInCustomer("bob");
    expect(await app.getMyOrder(other, { orderId })).toEqual({ ok: false, reason: "order_not_found" });
    expect(await app.getOrderForAdmin("", { orderId })).toEqual({ ok: false, reason: "unauthorized" });
  });
});

describe("事實查詢的綁定參數", () => {
  it("同一張訂單超過 100 個批次與物流回報時，仍只綁定訂單編號，不受 D1 綁定參數上限影響", async () => {
    const { orderId } = await paidMixedOrder();
    const shipmentCount = 105;
    await env.DB.batch([
      ...Array.from({ length: shipmentCount }, (_, index) => env.DB.prepare("INSERT INTO shipments (order_id, dispatch_key, actor, shipped_at) VALUES (?, ?, 'seed', ?)").bind(orderId, `seed-${index}`, 1_000 + index)),
      env.DB.prepare("INSERT INTO shipment_events (shipment_id, event_key, kind, occurred_at, recorded_at, actor) SELECT id, 'e', 'delivery_failed', 2000, 2000, 'seed' FROM shipments WHERE order_id = ?").bind(orderId),
    ]);

    const facts = await selectTimelineFacts(drizzle(env.DB), orderId, { loadShipmentEvents: true });

    expect(facts.shipmentEvents).toHaveLength(shipmentCount);
  });
});

describe("時間排序", () => {
  it("同一時間的事件依業務先後固定排序（與輸入順序無關），不同時間依時間", () => {
    const T = 1_000_000;
    const cancellation = (id: number, status: "pending" | "approved") => ({ id, orderId: 1, status, reason: "", requestedAt: T, decidedAt: status === "approved" ? T : null, decisionNote: null, goodsTwd: null, shippingTwd: null, refund: null, items: [{ orderLineId: 1, productName: "杯", variantLabel: "", deliveryType: "standard" as const, quantity: 1, amountTwd: 320 }] });
    const refund = (id: number) => ({ id, paymentId: 1, reason: "cancellation" as const, amountTwd: 320, goodsTwd: 320, shippingTwd: 0, status: "succeeded" as const, createdAt: T, settledAt: T });
    const source = {
      order: { id: 1, status: "paid", createdAt: T, lines: [], shipments: [] },
      payments: [{ id: 1, amountTwd: 320, status: "succeeded", createdAt: T, needsAttention: false }],
      refunds: [refund(9), refund(2)],
      invoices: [],
      cancellations: [cancellation(5, "approved"), cancellation(3, "approved")],
      returns: [], losses: [], shipmentReturns: [],
      facts: { paymentResults: [{ paymentId: 1, outcome: "succeeded", at: T }], shipmentEvents: [], allowances: [] },
    } satisfies TimelineSource;

    const events = buildCustomerTimeline(source).events.map((event) => event.id);
    const reversed = buildCustomerTimeline({ ...source, refunds: [...source.refunds].reverse(), cancellations: [...source.cancellations].reverse() }).events.map((event) => event.id);

    expect(events).toEqual(["order_placed:1", "payment_succeeded:1", "cancellation_requested:3", "cancellation_requested:5", "cancellation_approved:3", "cancellation_approved:5", "refund_registered:2", "refund_registered:9", "refund_succeeded:2", "refund_succeeded:9"]);
    expect(reversed).toEqual(events);
  });
});

describe("付款事件只取套用過的結果", () => {
  it("付款成功之後才到的失敗事件只留紀錄，時間線只有一筆付款成功（顧客與管理員）", async () => {
    const cookie = await signInCustomer("alice");
    const { orderId } = await placeMugOrder(cookie);
    const gateway = installFakeGateway();
    const gatewayPaymentId = await startPaymentFor(cookie, orderId, gateway);
    await app.applyPaymentResult(gateway.settle(gatewayPaymentId, "succeeded"));
    await app.applyPaymentResult({ eventId: "evt_stray", gatewayPaymentId, outcome: "failed" });

    for (const detail of [await adminOrder(orderId), await orderOf(cookie, orderId)]) {
      expect(kindsOf(detail.timeline).filter((kind) => kind.startsWith("payment_"))).toEqual(["payment_succeeded"]);
    }
  });

  it("付款失敗之後晚到的成功事件：時間線的付款事件與付款現況一致，一筆付款只有一筆", async () => {
    const cookie = await signInCustomer("alice");
    const { orderId } = await placeMugOrder(cookie);
    const gateway = installFakeGateway();
    const gatewayPaymentId = await startPaymentFor(cookie, orderId, gateway);
    await app.applyPaymentResult(gateway.settle(gatewayPaymentId, "failed"));
    await app.applyPaymentResult({ eventId: "evt_late", gatewayPaymentId, outcome: "succeeded" });

    const detail = await adminOrder(orderId);
    const status = detail.payments[0]!.status;
    expect(kindsOf(detail.timeline).filter((kind) => kind.startsWith("payment_"))).toEqual([status === "succeeded" ? "payment_succeeded" : "payment_failed"]);
  });
});

describe("已送達與只留紀錄的物流回報", () => {
  it("部分遺失之後才送達的批次：已送達的數量是批次扣掉遺失，與送達事件的數量一致", async () => {
    const { orderId, cookie, mugLine } = await paidMixedOrder();
    const batch = await shipItems(orderId, [{ orderLineId: mugLine.id, quantity: 2 }]);
    await confirmLossOk(batch, [{ orderLineId: mugLine.id, quantity: 1 }]);
    const { shippedAt } = await adminShipment(orderId, batch);
    setNow(shippedAt! + 180 * MINUTE);
    await reportShipmentEvent(batch, "evt-late", "delivered", shippedAt! + 60 * MINUTE);

    for (const detail of [await adminOrder(orderId), await orderOf(cookie, orderId)]) {
      expect(detail.shipments[0]).toMatchObject({ deliveryStatus: "lost" });
      const delivered = detail.timeline.events.filter((event) => event.kind === "shipment_delivered");
      expect(delivered.map((event) => event.quantity)).toEqual([1]);
      expect(detail.timeline.progress.quantities.delivered).toBe(1);
    }
  });

  it("送達之後、確認遺失之後、物流退回登記之後才發生的失敗與再次配送回報不是事件；送達之前的照常列出", async () => {
    const { orderId, cookie, mugLine } = await paidMixedOrder();
    const delivered = await shipItems(orderId, [{ orderLineId: mugLine.id, quantity: 1 }]);
    const lost = await shipItems(orderId, [{ orderLineId: mugLine.id, quantity: 1 }]);
    const sentBack = await shipItems(orderId, [{ orderLineId: mugLine.id, quantity: 1 }]);
    const { shippedAt } = await adminShipment(orderId, sentBack);
    setNow(shippedAt! + 10 * MINUTE);
    await reportShipmentEvent(delivered, "d-fail-before", "delivery_failed", shippedAt! + 1 * MINUTE);
    await reportShipmentEvent(delivered, "d-ok", "delivered", shippedAt! + 2 * MINUTE);
    await confirmLossOk(lost, [{ orderLineId: mugLine.id, quantity: 1 }]);
    await shipmentReturnAllSellable(sentBack, [{ orderLineId: mugLine.id, quantity: 1 }]).catch(() => undefined);
    const afterLoss = (await adminOrder(orderId)).losses[0]!.confirmedAt;
    const afterReturn = (await adminOrder(orderId)).shipmentReturns[0]!.declaredAt;
    const later = Math.max(afterLoss, afterReturn) + 5 * MINUTE;
    setNow(later + 5 * MINUTE);
    await reportShipmentEvent(delivered, "d-fail-after", "delivery_failed", shippedAt! + 3 * MINUTE);
    await reportShipmentEvent(delivered, "d-redo-after", "redelivery", shippedAt! + 4 * MINUTE);
    await reportShipmentEvent(lost, "l-fail-after", "delivery_failed", later);
    await reportShipmentEvent(sentBack, "s-redo-after", "redelivery", later);

    for (const detail of [await adminOrder(orderId), await orderOf(cookie, orderId)]) {
      const reports = detail.timeline.events.filter((event) => event.kind === "shipment_delivery_failed" || event.kind === "shipment_redelivery");
      expect(reports.map((event) => event.at)).toEqual([shippedAt! + 1 * MINUTE]);
    }
  });
});

describe("混合情境同源對帳", () => {
  it("遺失、物流退回、自助退貨完成與取消待審並存：進度與事件數量金額等於各域紀錄", async () => {
    const { orderId, cookie, mugLine, tableLine } = await paidMixedOrder();
    const mug = (quantity: number) => [{ orderLineId: mugLine.id, quantity }];
    const lostBatch = await shipItems(orderId, mug(1));
    await confirmLossOk(lostBatch, mug(1));
    const sentBackBatch = await shipItems(orderId, mug(1));
    await shipmentReturnAllSellable(sentBackBatch, mug(1));
    const deliveredBatch = await shipItems(orderId, mug(1));
    const { shippedAt } = await adminShipment(orderId, deliveredBatch);
    setNow(shippedAt! + 180 * MINUTE);
    expect(await reportShipmentEvent(deliveredBatch, "evt-mixed-delivered", "delivered", shippedAt! + 60 * MINUTE)).toMatchObject({ ok: true });
    const requested = await requestReturn(cookie, orderId, [{ orderLineId: mugLine.id, shipmentId: deliveredBatch, quantity: 1 }]);
    if (!requested.ok) throw new Error(`自助退貨失敗：${requested.reason}`);
    await approveReturn(requested.data.requestId);
    await receiveReturn(requested.data.requestId, [{ orderLineId: mugLine.id, receivedQuantity: 1 }]);
    await inspectReturn(requested.data.requestId, [{ orderLineId: mugLine.id, sellableQuantity: 1, damagedQuantity: 0 }]);
    await requestCancelOk(cookie, orderId, [{ orderLineId: tableLine.id, quantity: 1 }]);

    const detail = await adminOrder(orderId);
    expect(detail.returns[0]).toMatchObject({ status: "completed", selfService: true });
    const qty = (items: { quantity: number }[]) => items.reduce((total, item) => total + item.quantity, 0);
    const domain = {
      lost: detail.losses.reduce((total, loss) => total + qty(loss.items), 0),
      shipmentReturned: detail.shipmentReturns.reduce((total, sentBack) => total + qty(sentBack.items), 0),
      returned: detail.returns.filter((request) => request.status === "completed").reduce((total, request) => total + qty(request.items), 0),
      pendingCancellation: detail.cancellations.filter((request) => request.status === "pending").reduce((total, request) => total + qty(request.items), 0),
    };
    expect(domain).toEqual({ lost: 1, shipmentReturned: 1, returned: 1, pendingCancellation: 1 });

    for (const view of [detail, await orderOf(cookie, orderId)]) {
      const { quantities, money } = view.timeline.progress;
      expect(quantities).toMatchObject({ ...domain, delivered: 1, awaitingDispatch: 0, dispatched: 3 });
      const eventQuantity = (kind: string) => view.timeline.events.filter((event) => event.kind === kind).reduce((total, event) => total + (event.quantity ?? 0), 0);
      expect(eventQuantity("loss_confirmed")).toBe(domain.lost);
      expect(eventQuantity("shipment_return_declared")).toBe(domain.shipmentReturned);
      expect(eventQuantity("return_inspected")).toBe(domain.returned);
      expect(eventQuantity("cancellation_requested")).toBe(domain.pendingCancellation);
      expect(eventQuantity("shipment_delivered")).toBe(quantities.delivered);
      const byReason = (rows: { reason: string; amountTwd: number }[]) => rows.reduce<Record<string, number>>((groups, row) => ({ ...groups, [row.reason]: (groups[row.reason] ?? 0) + row.amountTwd }), {});
      const settled = detail.refunds.filter((refund) => refund.status === "succeeded");
      const settledEvents = view.timeline.events.filter((event) => event.kind === "refund_succeeded").map((event) => ({ reason: event.detail!, amountTwd: event.amountTwd! }));
      expect(byReason(settledEvents)).toEqual(byReason(settled));
      expect(Object.keys(byReason(settled)).sort()).toEqual(["loss", "return", "shipment_return"]);
      expect(money.refundedTwd).toBe(settled.reduce((total, refund) => total + refund.amountTwd, 0));
      expect(money.allowedTwd).toBe(detail.invoices.flatMap((invoice) => invoice.allowances).filter((allowance) => allowance.status === "issued").reduce((total, allowance) => total + allowance.amountTwd, 0));
    }
  });
});
