import { env, exports } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import { buildCustomerTimeline, type TimelineSource } from "../src/orders/timeline";
import { selectTimelineFacts } from "../src/orders/timeline-facts";
import { mintAccessJwt } from "./access";
import { approveOk, paidMixedOrder, requestCancelOk } from "./cancellation-helpers";
import { setNow } from "./clock";
import { resetDb } from "./db";
import { shipItems } from "./loss-helpers";
import { orderOf } from "./payment-helpers";
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
    const { signInCustomer } = await import("./customers");
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

    const facts = await selectTimelineFacts(drizzle(env.DB), orderId);

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
