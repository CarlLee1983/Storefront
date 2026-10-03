import { exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { mintAccessJwt } from "./access";
import { approveOk, requestCancelOk } from "./cancellation-helpers";
import { checkoutInput, createStockedListing, newKey } from "./checkout-helpers";
import { setNow } from "./clock";
import { signInCustomer } from "./customers";
import { resetDb } from "./db";
import { installFakeGateway } from "./fake-gateway";
import { confirmLossOk, shipItems } from "./loss-helpers";
import { startPaymentFor } from "./payment-helpers";
import { approveReturn, inspectReturn, receiveReturn, requestReturnOk, stockDetail } from "./return-helpers";
import { adminOrder, adminShipment, reportShipmentEvent } from "./shipment-helpers";

const app = exports.default;
const MINUTE = 60_000;

beforeEach(resetDb);

/**
 * T24 整體商務演練（同一張訂單）：燈具 3 件 x 1,000（一般配送）、桌子 1 件 x 6,000（大型配送），運費 100 + 600，收款 9,700。
 * 全部走既有公開 RPC 與閘道故障開關；`faults` 為真時在相同流程注入第一筆退款明確失敗、延遲開票、折讓失敗與通知投遞失敗，並一一補辦。
 */
async function rehearse({ faults }: { faults: boolean }) {
  const jwt = await mintAccessJwt();
  const cookie = await signInCustomer("alice");
  const lamp = await createStockedListing("燈具", 1000, 3);
  const table = await createStockedListing("桌子", 6000, 1, "large");
  const gateway = installFakeGateway();
  if (faults) gateway.loseNextInvoiceResponse();

  // 步驟 1：下單保留全部數量；付款後轉已付款保留，實體不變
  const placed = await app.checkout(cookie, checkoutInput([
    { variantId: lamp.variantId, quantity: 3, seenUnitPriceTwd: 1000 },
    { variantId: table.variantId, quantity: 1, seenUnitPriceTwd: 6000 },
  ], newKey(), 700));
  if (!placed.ok) throw new Error(`結帳失敗：${placed.reason}`);
  const orderId = placed.data.orderId;
  expect(placed.data.totalTwd).toBe(9700);
  expect(await stockDetail(lamp.variantId)).toEqual({ onHand: 3, unavailable: 0, reserved: 3, available: 0 });
  expect(await stockDetail(table.variantId)).toEqual({ onHand: 1, unavailable: 0, reserved: 1, available: 0 });
  const gatewayPaymentId = await startPaymentFor(cookie, orderId, gateway);
  expect(await app.applyPaymentResult(gateway.settle(gatewayPaymentId, "succeeded"))).toMatchObject({ ok: true, data: { orderStatus: "paid" } });
  expect(await stockDetail(lamp.variantId)).toEqual({ onHand: 3, unavailable: 0, reserved: 3, available: 0 });
  expect(await stockDetail(table.variantId)).toEqual({ onHand: 1, unavailable: 0, reserved: 1, available: 0 });
  const order = await adminOrder(orderId);
  const lampLine = order.lines.find((line) => line.variantId === lamp.variantId)!;
  const tableLine = order.lines.find((line) => line.variantId === table.variantId)!;

  // 步驟 2：交運燈具 2 件，另 1 件申請並核准取消，退款 1,000、一般運費暫不退
  const batchA = await shipItems(orderId, [{ orderLineId: lampLine.id, quantity: 2 }]);
  const requestId = await requestCancelOk(cookie, orderId, [{ orderLineId: lampLine.id, quantity: 1 }]);
  if (faults) gateway.failNextRefundExplicitly();
  await approveOk(requestId);
  expect((await adminOrder(orderId)).refunds).toMatchObject([{ reason: "cancellation", amountTwd: 1000, goodsTwd: 1000, shippingTwd: 0, status: faults ? "failed" : "succeeded" }]);
  // 退款失敗不恢復出貨，庫存照取消結果：實體 1、沒有保留、可售 1
  expect(await stockDetail(lamp.variantId)).toEqual({ onHand: 1, unavailable: 0, reserved: 0, available: 1 });
  if (faults) {
    expect(await app.retryRefund(jwt, { refundId: (await adminOrder(orderId)).refunds[0]!.id })).toMatchObject({ ok: true });
    // 原票延遲未開立：折讓先等著；補辦原票時折讓先失敗，再由管理員補辦折讓
    const [invoice] = (await adminOrder(orderId)).invoices;
    expect(invoice).toMatchObject({ status: "unknown", allowedTwd: 0, pendingAllowanceTwd: 1000 });
    gateway.failNextAllowanceExplicitly();
    expect(await app.retryInvoice(jwt, { invoiceId: invoice!.id })).toEqual({ ok: true, data: { status: "issued" } });
    expect((await adminOrder(orderId)).invoices).toMatchObject([{ status: "issued", allowedTwd: 0, pendingAllowanceTwd: 1000 }]);
    expect(await app.retryAllowance(jwt, { refundId: (await adminOrder(orderId)).refunds[0]!.id })).toMatchObject({ ok: true });
  }
  expect((await adminOrder(orderId)).refunds).toMatchObject([{ status: "succeeded" }]);
  expect(await stockDetail(lamp.variantId)).toEqual({ onHand: 1, unavailable: 0, reserved: 0, available: 1 });

  // 步驟 3：已送達的 2 件退回 1 件，檢查合格後退款 1,000，一般運費保留
  const { shippedAt } = await adminShipment(orderId, batchA);
  setNow(shippedAt! + 180 * MINUTE);
  expect(await reportShipmentEvent(batchA, "evt-a-delivered", "delivered", shippedAt! + 60 * MINUTE)).toMatchObject({ ok: true });
  const returnId = await requestReturnOk(cookie, orderId, [{ orderLineId: lampLine.id, quantity: 1 }]);
  await approveReturn(returnId);
  expect(await receiveReturn(returnId, [{ orderLineId: lampLine.id, receivedQuantity: 1 }])).toMatchObject({ ok: true });
  expect(await inspectReturn(returnId, [{ orderLineId: lampLine.id, sellableQuantity: 1, damagedQuantity: 0 }])).toMatchObject({ ok: true });
  expect(await stockDetail(lamp.variantId)).toEqual({ onHand: 2, unavailable: 0, reserved: 0, available: 2 });
  expect((await adminOrder(orderId)).refunds.map((refund) => [refund.reason, refund.goodsTwd, refund.shippingTwd])).toEqual([["cancellation", 1000, 0], ["return", 1000, 0]]);

  // 步驟 4：桌子另批交運後確認遺失，退商品 6,000 與大型原運費 600，不回補庫存
  const batchB = await shipItems(orderId, [{ orderLineId: tableLine.id, quantity: 1 }], true);
  if (faults) await app.setMailDeliveryFailure(await mintAccessJwt(), { enabled: true });
  await confirmLossOk(batchB, [{ orderLineId: tableLine.id, quantity: 1 }]);
  if (faults) {
    await app.setMailDeliveryFailure(await mintAccessJwt(), { enabled: false });
    const listed = await app.listMailForAdmin(await mintAccessJwt());
    if (!listed.ok) throw new Error("讀取信件失敗");
    const pending = listed.data.messages.filter((message) => message.needsAttention);
    expect(pending.length).toBeGreaterThan(0);
    for (const message of pending) expect(await app.resendMail(await mintAccessJwt(), { messageId: message.id })).toEqual({ ok: true, data: { delivered: true } });
    const after = await app.listMailForAdmin(await mintAccessJwt());
    expect(after.ok && after.data.messages.filter((message) => message.needsAttention)).toEqual([]);
  }
  expect(await stockDetail(table.variantId)).toEqual({ onHand: 0, unavailable: 0, reserved: 0, available: 0 });

  // 步驟 5：三筆退款 8,600、剩額 1,100、發票原額 9,700、折讓 8,600、餘額 1,100
  const final = await adminOrder(orderId);
  const customerView = await app.getMyOrder(cookie, { orderId });
  if (!customerView.ok) throw new Error("讀取訂單失敗");
  const mail = await app.listMyMail(cookie);
  if (!mail.ok) throw new Error("讀信失敗");
  const countKinds = (kinds: string[]) => kinds.reduce<Record<string, number>>((counts, kind) => ({ ...counts, [kind]: (counts[kind] ?? 0) + 1 }), {});
  return {
    stock: { lamp: await stockDetail(lamp.variantId), table: await stockDetail(table.variantId) },
    refunds: final.refunds.map((refund) => [refund.reason, refund.goodsTwd, refund.shippingTwd, refund.amountTwd, refund.status]),
    refundedTwd: final.timeline.progress.money.refundedTwd,
    gatewayRefundedTwd: gateway.refundedTwd(gatewayPaymentId),
    invoice: final.invoices.map((invoice) => ({ status: invoice.status, amountTwd: invoice.amountTwd, allowedTwd: invoice.allowedTwd, allowedCount: invoice.allowedCount, pendingAllowanceTwd: invoice.pendingAllowanceTwd })),
    gatewayInvoices: [...gateway.invoices.values()].map((invoice) => invoice.amountTwd),
    gatewayAllowances: [...gateway.allowances.values()].map((allowance) => allowance.amountTwd).sort(),
    adminEvents: countKinds(final.timeline.events.map((event) => event.kind)),
    customerEvents: countKinds(customerView.data.timeline.events.map((event) => event.kind)),
    mailKinds: countKinds(mail.data.map((message) => message.kind)),
    money: final.timeline.progress.money,
    todos: final.timeline.todos,
  };
}

describe("T24 整體商務演練（9,700 元訂單）", () => {
  it("逐步：庫存、三筆退款 8,600、收款剩額 1,100、發票 9,700 原額 / 8,600 折讓 / 1,100 餘額、時間線事件", async () => {
    const result = await rehearse({ faults: false });

    expect(result.stock).toEqual({
      lamp: { onHand: 2, unavailable: 0, reserved: 0, available: 2 },
      table: { onHand: 0, unavailable: 0, reserved: 0, available: 0 },
    });
    expect(result.refunds).toEqual([["cancellation", 1000, 0, 1000, "succeeded"], ["return", 1000, 0, 1000, "succeeded"], ["loss", 6000, 600, 6600, "succeeded"]]);
    expect(result.refundedTwd).toBe(8600);
    expect(result.gatewayRefundedTwd).toBe(8600);
    expect(result.money).toMatchObject({ paidTwd: 9700, refundedTwd: 8600, refundOpenTwd: 0, allowedTwd: 8600, allowancePendingTwd: 0 });
    expect(result.money.paidTwd - result.money.refundedTwd).toBe(1100);
    expect(result.invoice).toEqual([{ status: "issued", amountTwd: 9700, allowedTwd: 8600, allowedCount: 3, pendingAllowanceTwd: 0 }]);
    expect(result.invoice[0]!.amountTwd - result.invoice[0]!.allowedTwd).toBe(1100);
    expect(result.gatewayInvoices).toEqual([9700]);
    expect(result.gatewayAllowances).toEqual([1000, 1000, 6600]);
    expect(result.adminEvents).toMatchObject({
      order_placed: 1, payment_succeeded: 1, shipment_dispatched: 2, shipment_delivered: 1, cancellation_requested: 1, cancellation_approved: 1,
      return_requested: 1, return_approved: 1, return_received: 1, return_inspected: 1, loss_confirmed: 1,
      refund_registered: 3, refund_succeeded: 3, invoice_issued: 1, allowance_issued: 3,
    });
    expect(result.adminEvents).not.toHaveProperty("refund_failed");
    expect(result.customerEvents).toEqual(result.adminEvents);
    expect(result.todos).toEqual([]);
  });

  it("注入第一筆退款明確失敗、延遲開票、折讓失敗與通知投遞失敗並補辦：金額與庫存與無故障演練相同，時間線保留各次業務事實，技術重試不成為新事件", async () => {
    const clean = await rehearse({ faults: false });
    await resetDb();
    const faulted = await rehearse({ faults: true });

    expect(faulted.stock).toEqual(clean.stock);
    expect(faulted.refunds).toEqual(clean.refunds);
    expect(faulted.refundedTwd).toBe(8600);
    expect(faulted.gatewayRefundedTwd).toBe(8600);
    expect(faulted.invoice).toEqual(clean.invoice);
    expect(faulted.gatewayInvoices).toEqual([9700]);
    expect(faulted.gatewayAllowances).toEqual(clean.gatewayAllowances);
    expect(faulted.money).toEqual(clean.money);
    expect(faulted.mailKinds).toEqual(clean.mailKinds);
    // 管理員時間線多一筆「退款失敗」的業務事實，其餘與無故障相同；顧客看不到退款失敗
    expect(faulted.adminEvents).toEqual({ ...clean.adminEvents, refund_failed: 1 });
    expect(faulted.customerEvents).toEqual(clean.customerEvents);
    expect(faulted.todos).toEqual([]);
  });
});
