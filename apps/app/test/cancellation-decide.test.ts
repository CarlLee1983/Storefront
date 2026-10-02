import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { commitRefund } from "../src/payments/refunds";
import { mintAccessJwt } from "./access";
import { approveOk, decide, paidMixedOrder, requestCancelOk } from "./cancellation-helpers";
import { resetDb, seedPayment } from "./db";
import { orderOf, stockOf } from "./payment-helpers";
import { adminOrder, APPOINTMENT, shipRemaining } from "./shipment-helpers";

const app = exports.default;

// 每個測試都要建商品、走完付款與下單，全套並行時會比預設 5 秒慢（比照 admin-ship）
vi.setConfig({ testTimeout: 30_000 });

beforeEach(resetDb);

const refundsOf = async (orderId: number) => (await adminOrder(orderId)).refunds;
const kindsOf = async (cookie: string) => {
  const mail = await app.listMyMail(cookie);
  if (!mail.ok) throw new Error("讀信失敗");
  return mail.data.map((message) => message.kind).sort();
};
const retry = async (refundId: number) => app.retryRefund(await mintAccessJwt(), { refundId });

describe("審核取消：拒絕", () => {
  it("拒絕解凍：數量恢復可交運、不產生退款，留審核人與備註，顧客收到拒絕通知；重送冪等、不能再改核准", async () => {
    const { cookie, orderId, mugLine } = await paidMixedOrder();
    const requestId = await requestCancelOk(cookie, orderId, [{ orderLineId: mugLine.id, quantity: 3 }]);
    expect(await shipRemaining(orderId, { items: [{ orderLineId: mugLine.id, quantity: 1 }] })).toEqual({ ok: false, reason: "shipment_quantity_exceeded" });

    const rejected = await decide(requestId, "reject", "已在備貨");

    expect(rejected).toEqual({ ok: true, data: { requestId, decision: "rejected", replayed: false, refund: null } });
    expect(await decide(requestId, "reject")).toMatchObject({ ok: true, data: { replayed: true } });
    expect(await decide(requestId, "approve")).toEqual({ ok: false, reason: "cancellation_already_decided" });
    expect(await shipRemaining(orderId, { items: [{ orderLineId: mugLine.id, quantity: 3 }] })).toMatchObject({ ok: true });
    const order = await adminOrder(orderId);
    expect(order.refunds).toEqual([]);
    expect(order.cancellations).toMatchObject([{ status: "rejected", decidedBy: "admin@example.com", decisionNote: "已在備貨", refund: null }]);
    expect((await kindsOf(cookie)).filter((kind) => kind === "cancellation_rejected")).toHaveLength(1);
  });
});

describe("審核取消：核准、釋放保留與實付單價退款", () => {
  it("部分取消：釋放這些數量的保留、停止履約，按原實付單價退商品款（改價不影響）、運費不退，退款成功並通知；剩餘出完轉已出貨", async () => {
    const { cookie, orderId, gateway, mugVariantId, mugLine, tableLine } = await paidMixedOrder();
    const before = await stockOf(mugVariantId);
    const requestId = await requestCancelOk(cookie, orderId, [{ orderLineId: mugLine.id, quantity: 2 }]);
    expect(await stockOf(mugVariantId)).toEqual(before);
    await env.DB.prepare("UPDATE product_variants SET price_twd = 999 WHERE id = ?").bind(mugVariantId).run();

    const approved = await approveOk(requestId);

    expect(approved).toMatchObject({ decision: "approved", replayed: false, refund: { status: "succeeded" } });
    expect(await stockOf(mugVariantId)).toEqual({ onHand: before.onHand, available: before.available + 2 });
    const order = await adminOrder(orderId);
    expect(order.status).toBe("paid");
    expect(order.lines.find((line) => line.id === mugLine.id)).toMatchObject({ cancelledQuantity: 2, pendingCancellationQuantity: 0 });
    expect(order.refunds).toMatchObject([{ reason: "cancellation", amountTwd: 640, goodsTwd: 640, shippingTwd: 0, status: "succeeded" }]);
    expect(order.cancellations).toMatchObject([{ status: "approved", goodsTwd: 640, shippingTwd: 0, refund: { id: approved.refund!.id, amountTwd: 640, status: "succeeded" } }]);
    expect(gateway.refundRequests).toMatchObject([{ amountTwd: 640 }]);
    expect(await kindsOf(cookie)).toEqual(expect.arrayContaining(["cancellation_approved", "refund_succeeded"]));
    expect((await orderOf(cookie, orderId)).refunds).toMatchObject([{ reason: "cancellation", amountTwd: 640, status: "succeeded" }]);

    // 剩下的 1 個馬克杯與餐桌都交運後，訂單出完（取消的數量不再等待交運）
    const rest = await shipRemaining(orderId, { items: [{ orderLineId: mugLine.id, quantity: 1 }, { orderLineId: tableLine.id, quantity: 1 }], appointment: APPOINTMENT });
    expect(rest).toMatchObject({ ok: true, data: { status: "shipped" } });
  });

  it("全部數量取消：訂單轉已取消、保留全數釋放、兩類運費各退一次，退款等於實收；已取消不能再交運", async () => {
    const { cookie, orderId, totalTwd, mugVariantId, tableVariantId, mugLine, tableLine } = await paidMixedOrder();
    const requestId = await requestCancelOk(cookie, orderId, [{ orderLineId: mugLine.id, quantity: 3 }, { orderLineId: tableLine.id, quantity: 1 }]);

    await approveOk(requestId);

    const order = await adminOrder(orderId);
    expect(order.status).toBe("cancelled");
    expect(order.refunds).toMatchObject([{ amountTwd: totalTwd, goodsTwd: 3 * 320 + 6000, shippingTwd: 700, status: "succeeded" }]);
    expect(await stockOf(mugVariantId)).toEqual({ onHand: 10, available: 10 });
    expect(await stockOf(tableVariantId)).toEqual({ onHand: 5, available: 5 });
    expect(await shipRemaining(orderId)).toMatchObject({ ok: false, reason: "order_not_shippable" });
    expect(await app.requestCancellation(cookie, { orderId, requestKey: "k2", items: [{ orderLineId: mugLine.id, quantity: 1 }] })).toEqual({ ok: false, reason: "order_not_cancellable" });
  });

  it("同類全數取消才退該類原運費一次：分兩案取消同一類，只有補齊的那一案退運費；另一類不受影響", async () => {
    const { cookie, orderId, totalTwd, mugLine, tableLine } = await paidMixedOrder();
    const first = await requestCancelOk(cookie, orderId, [{ orderLineId: mugLine.id, quantity: 2 }]);
    const second = await requestCancelOk(cookie, orderId, [{ orderLineId: mugLine.id, quantity: 1 }]);
    const table = await requestCancelOk(cookie, orderId, [{ orderLineId: tableLine.id, quantity: 1 }]);

    // 核准順序與申請順序不同也一樣：運費由「補齊該類」的那一案退
    await approveOk(second);
    await approveOk(first);
    await approveOk(table);

    const refunds = await refundsOf(orderId);
    expect(refunds.map((refund) => [refund.goodsTwd, refund.shippingTwd])).toEqual([[320, 0], [640, 100], [6000, 600]]);
    expect(refunds.reduce((sum, refund) => sum + refund.amountTwd, 0)).toBe(totalTwd);
    expect((await adminOrder(orderId)).status).toBe("cancelled");
  });

  it("已有部分交運：取消剩餘未交運的數量，同類沒有全數取消所以不退運費；剩餘都交運完後轉已出貨", async () => {
    const { cookie, orderId, mugLine } = await paidMixedOrder();
    expect(await shipRemaining(orderId, { items: [{ orderLineId: mugLine.id, quantity: 1 }] })).toMatchObject({ ok: true });
    const requestId = await requestCancelOk(cookie, orderId, [{ orderLineId: mugLine.id, quantity: 2 }]);

    await approveOk(requestId);

    expect(await refundsOf(orderId)).toMatchObject([{ goodsTwd: 640, shippingTwd: 0 }]);
    expect((await adminOrder(orderId)).status).toBe("partially_shipped");
  });
});

describe("審核取消：退款失敗與同單逐筆", () => {
  it("核准後退款明確失敗：取消結果不變、不恢復出貨、保留維持釋放；退款留在待辦，原紀錄重試後成功並通知", async () => {
    const { cookie, orderId, gateway, mugVariantId, mugLine } = await paidMixedOrder();
    const before = await stockOf(mugVariantId);
    const requestId = await requestCancelOk(cookie, orderId, [{ orderLineId: mugLine.id, quantity: 2 }]);
    gateway.failNextRefundExplicitly();

    const approved = await approveOk(requestId);

    expect(approved.refund).toMatchObject({ status: "failed" });
    const order = await adminOrder(orderId);
    expect(order.cancellations).toMatchObject([{ status: "approved" }]);
    expect(order.lines.find((line) => line.id === mugLine.id)!.cancelledQuantity).toBe(2);
    expect(await stockOf(mugVariantId)).toEqual({ onHand: before.onHand, available: before.available + 2 });
    expect(await shipRemaining(orderId, { items: [{ orderLineId: mugLine.id, quantity: 2 }] })).toEqual({ ok: false, reason: "shipment_quantity_exceeded" });
    expect(await kindsOf(cookie)).not.toContain("refund_succeeded");
    const todos = await app.listRefundsToHandle(await mintAccessJwt());
    expect(todos).toMatchObject({ ok: true, data: { refunds: [{ id: approved.refund!.id, status: "failed" }] } });

    expect(await retry(approved.refund!.id)).toMatchObject({ ok: true, data: { status: "succeeded" } });
    expect(await refundsOf(orderId)).toHaveLength(1);
    expect(await kindsOf(cookie)).toContain("refund_succeeded");
  });

  it("前筆結果不明時後筆等待（核准照常成立、退款留 pending）；查證結案後後筆才能執行", async () => {
    const { cookie, orderId, gateway, mugLine } = await paidMixedOrder();
    const first = await requestCancelOk(cookie, orderId, [{ orderLineId: mugLine.id, quantity: 1 }]);
    const second = await requestCancelOk(cookie, orderId, [{ orderLineId: mugLine.id, quantity: 1 }]);
    gateway.loseNextRefundResponse();

    const unknown = await approveOk(first);
    const waiting = await approveOk(second);

    expect(unknown.refund!.status).toBe("unknown");
    expect(waiting.refund!.status).toBe("pending");
    expect(await retry(waiting.refund!.id)).toEqual({ ok: false, reason: "refund_blocked" });
    expect(await retry(unknown.refund!.id)).toMatchObject({ ok: true, data: { status: "succeeded" } });
    expect(await retry(waiting.refund!.id)).toMatchObject({ ok: true, data: { status: "succeeded" } });
    expect(gateway.refundedTwd(gateway.payments.keys().next().value!)).toBe(640);
  });

  it("前筆明確失敗時後筆可前進，失敗那筆仍保留額度；重試沿用原紀錄", async () => {
    const { cookie, orderId, gateway, mugLine } = await paidMixedOrder();
    const first = await requestCancelOk(cookie, orderId, [{ orderLineId: mugLine.id, quantity: 1 }]);
    const second = await requestCancelOk(cookie, orderId, [{ orderLineId: mugLine.id, quantity: 1 }]);
    gateway.failNextRefundExplicitly();

    const failed = await approveOk(first);
    const next = await approveOk(second);

    expect(failed.refund!.status).toBe("failed");
    expect(next.refund!.status).toBe("succeeded");
    expect(await retry(failed.refund!.id)).toMatchObject({ ok: true, data: { status: "succeeded" } });
    expect(await refundsOf(orderId)).toHaveLength(2);
  });

  it("額度被其他退款占用時，核准照常成立但不登記退款（成功加承諾不超實收）；重送核准不重複、不超額", async () => {
    const { cookie, orderId, totalTwd, mugLine } = await paidMixedOrder();
    const payment = (await env.DB.prepare("SELECT id FROM payments WHERE order_id = ?").bind(orderId).first<{ id: number }>())!;
    expect(await commitRefund(env.DB, { paymentId: payment.id, reason: "cancelled_order", amountTwd: totalTwd - 100, goodsTwd: totalTwd - 100, shippingTwd: 0 }, Date.now())).not.toBeNull();
    const requestId = await requestCancelOk(cookie, orderId, [{ orderLineId: mugLine.id, quantity: 1 }]);

    const approved = await approveOk(requestId);
    const again = await approveOk(requestId);

    expect(approved.refund).toBeNull();
    expect(again).toMatchObject({ replayed: true, refund: null });
    const order = await adminOrder(orderId);
    expect(order.cancellations).toMatchObject([{ status: "approved", refund: null }]);
    expect(order.refunds).toHaveLength(1);
    // 款項沒有任何退款在處理：列進退款待辦，通知不承諾退款完成會另行通知
    const todos = await app.listRefundsToHandle(await mintAccessJwt());
    expect(todos).toMatchObject({ ok: true, data: { unregisteredCancellations: [{ id: requestId, orderId, goodsTwd: 320, shippingTwd: 0, refund: null }] } });
    const mail = await app.listMyMail(cookie);
    const notice = mail.ok ? mail.data.find((message) => message.kind === "cancellation_approved") : undefined;
    const body = await app.getMyMail(cookie, { messageId: notice!.id });
    expect(body).toMatchObject({ ok: true, data: { body: expect.stringContaining("客服會與你聯繫") } });
    expect(body).not.toMatchObject({ data: { body: expect.stringContaining("退款完成會另行通知") } });

    // 額度釋出後重送核准（「重新登記退款」）登記並執行這一案的退款，離開待辦
    await env.DB.prepare("DELETE FROM refunds WHERE reason = 'cancelled_order'").run();
    expect(await approveOk(requestId)).toMatchObject({ replayed: true, refund: { status: "succeeded" } });
    expect(await app.listRefundsToHandle(await mintAccessJwt())).toMatchObject({ ok: true, data: { unregisteredCancellations: [] } });
  });

  it("訂單沒有讓它成立的付款（paid_by_payment_id 為空）時核准照常成立、不登記退款，列進退款待辦", async () => {
    const { cookie, orderId, mugLine } = await paidMixedOrder();
    await env.DB.prepare("UPDATE orders SET paid_by_payment_id = NULL WHERE id = ?").bind(orderId).run();
    const requestId = await requestCancelOk(cookie, orderId, [{ orderLineId: mugLine.id, quantity: 1 }]);

    expect(await approveOk(requestId)).toMatchObject({ decision: "approved", refund: null });

    const todos = await app.listRefundsToHandle(await mintAccessJwt());
    expect(todos).toMatchObject({ ok: true, data: { unregisteredCancellations: [{ id: requestId, orderId }] } });
  });

  it("全部取消後（已取消、原本由某筆付款支付）又收到另一筆成功付款：整筆退款，原因是重複付款而不是取消時的付款", async () => {
    const { cookie, orderId, totalTwd, gateway, mugLine, tableLine } = await paidMixedOrder();
    await approveOk(await requestCancelOk(cookie, orderId, [{ orderLineId: mugLine.id, quantity: 3 }, { orderLineId: tableLine.id, quantity: 1 }]));
    expect((await adminOrder(orderId)).status).toBe("cancelled");
    const second = await seedPayment(orderId, "pending", "pay_second", totalTwd);
    gateway.adopt(second, { amountTwd: totalTwd, merchantReference: String(orderId) });

    await app.applyPaymentResult(gateway.settle(second, "succeeded"));

    expect((await refundsOf(orderId)).map((refund) => refund.reason)).toEqual(["cancellation", "duplicate_success"]);
  });

  it("同一案重複核准（含並行）只登記一筆退款、只寄一封通知，不重退", async () => {
    const { cookie, orderId, gateway, mugLine } = await paidMixedOrder();
    const requestId = await requestCancelOk(cookie, orderId, [{ orderLineId: mugLine.id, quantity: 1 }]);

    await Promise.all([decide(requestId, "approve"), decide(requestId, "approve")]);
    await approveOk(requestId);

    expect(await refundsOf(orderId)).toHaveLength(1);
    expect(gateway.refundRequests).toHaveLength(1);
    const kinds = await kindsOf(cookie);
    expect(kinds.filter((kind) => kind === "cancellation_approved")).toHaveLength(1);
    expect(kinds.filter((kind) => kind === "refund_succeeded")).toHaveLength(1);
  });
});

describe("取消審核待辦", () => {
  it("待辦只列待審的案件（含顧客 email 與明細），審核後離開待辦", async () => {
    const { cookie, orderId, mugLine, tableLine } = await paidMixedOrder();
    const first = await requestCancelOk(cookie, orderId, [{ orderLineId: mugLine.id, quantity: 1 }]);
    await requestCancelOk(cookie, orderId, [{ orderLineId: tableLine.id, quantity: 1 }]);
    await approveOk(first);

    const listed = await app.listCancellationsToReview(await mintAccessJwt());

    expect(listed).toMatchObject({ ok: true, data: { omitted: 0, cancellations: [{ status: "pending", orderId, customerEmail: "alice@example.com", items: [{ productName: "餐桌", quantity: 1 }] }] } });
  });
});
