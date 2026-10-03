import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { recordRefundAttempt } from "../src/payments/refunds";
import { createInvoiceService } from "../src/invoices/service";
import type { InvoiceGateway } from "../src/invoices/gateway";
import { ADMIN_EMAIL, mintAccessJwt } from "./access";
import { signInCustomer } from "./customers";
import { forceOrderStatus, resetDb, seedPayment } from "./db";
import { installFakeGateway } from "./fake-gateway";
import { orderOf, placeMugOrder, startPaymentFor } from "./payment-helpers";
import { app } from "./release-helpers";
import { shipRemaining } from "./shipment-helpers";

beforeEach(resetDb);

/** 一張待付款訂單與它的閘道付款（尚未結算）：測試在套用付款結果之前先安排發票服務的狀況。 */
async function orderWithPayment(name = "alice", gateway = installFakeGateway()) {
  const cookie = await signInCustomer(name);
  const { orderId, totalTwd } = await placeMugOrder(cookie);
  const gatewayPaymentId = await startPaymentFor(cookie, orderId, gateway);
  return { cookie, orderId, totalTwd, gateway, gatewayPaymentId, succeed: () => gateway.settle(gatewayPaymentId, "succeeded") };
}

/** 已取消訂單上的遲到付款：付款成功會登記整筆退款（讓退款事實在發票之前或同時成立）。 */
async function lateOrderWithPayment() {
  const fixture = await orderWithPayment();
  await forceOrderStatus(fixture.orderId, "cancelled");
  return fixture;
}

const adminInvoices = async (orderId: number) => {
  const found = await app.getOrderForAdmin(await mintAccessJwt(), { orderId });
  if (!found.ok) throw new Error("讀取訂單失敗");
  return found.data.invoices;
};
const todos = async () => {
  const listed = await app.listInvoicesToHandle(await mintAccessJwt());
  if (!listed.ok) throw new Error("讀取發票待辦失敗");
  return listed.data;
};
const retry = async (invoiceId: number) => app.retryInvoice(await mintAccessJwt(), { invoiceId });
const mailOf = async (cookie: string) => {
  const list = await app.listMyMail(cookie);
  if (!list.ok) throw new Error("讀信失敗");
  return list.data.filter((message) => message.kind === "invoice_issued");
};
const myInvoices = async (cookie: string, orderId: number) => (await orderOf(cookie, orderId)).invoices;

describe("成功收款開立一次原額模擬發票", () => {
  it("付款成功：向發票服務開立一張原額發票，顧客訂單頁看得到號碼與原額，通知寄到已驗證 email", async () => {
    const { cookie, orderId, totalTwd, gateway, succeed } = await orderWithPayment();

    await app.applyPaymentResult(succeed());

    expect(gateway.invoiceRequests).toEqual([{ invoiceKey: expect.stringMatching(/^inv_/), merchantReference: String(orderId), amountTwd: totalTwd }]);
    expect(await myInvoices(cookie, orderId)).toEqual([
      { id: expect.any(Number), paymentId: expect.any(Number), status: "issued", amountTwd: totalTwd, invoiceNumber: "SM-00000001", createdAt: expect.any(Number), issuedAt: expect.any(Number), pendingAllowanceTwd: 0, pendingAllowanceCount: 0 },
    ]);
    const [message] = await mailOf(cookie);
    expect(message).toMatchObject({ kind: "invoice_issued", recipientAddress: "contact-alice@example.com" });
    const opened = await app.getMyMail(cookie, { messageId: message!.id });
    expect(opened).toMatchObject({ ok: true, data: { body: expect.stringContaining(`SM-00000001`) } });
    expect(opened.ok && opened.data.body).toContain(`NT$${totalTwd}`);
  });

  it("事件重送、導回查詢與補查都不重複開立：同一個冪等鍵、一張發票、一封通知", async () => {
    const { cookie, orderId, gateway, gatewayPaymentId, succeed } = await orderWithPayment();
    const event = succeed();

    await app.applyPaymentResult(event);
    await app.applyPaymentResult(event);
    await app.confirmPayment(cookie, { orderId, gatewayPaymentId });
    await app.applyPaymentResult({ ...event, eventId: "evt_other" });

    expect(gateway.invoices.size).toBe(1);
    expect(new Set(gateway.invoiceRequests.map((request) => request.invoiceKey)).size).toBe(1);
    expect(await myInvoices(cookie, orderId)).toHaveLength(1);
    expect(await mailOf(cookie)).toHaveLength(1);
  });

  it("付款失敗不開立發票", async () => {
    const { cookie, orderId, gateway, gatewayPaymentId } = await orderWithPayment();

    await app.applyPaymentResult(gateway.settle(gatewayPaymentId, "failed"));

    expect(gateway.invoiceRequests).toEqual([]);
    expect(await myInvoices(cookie, orderId)).toEqual([]);
  });

  it("已失敗的付款後來才收到成功事件（付款狀態不再轉換）：不登記發票義務，也不開立", async () => {
    const { orderId, gateway, gatewayPaymentId } = await orderWithPayment();
    await app.applyPaymentResult(gateway.settle(gatewayPaymentId, "failed"));

    await app.applyPaymentResult({ eventId: "evt_late_success", gatewayPaymentId, outcome: "succeeded" });

    expect((await adminInvoices(orderId))).toEqual([]);
    expect(gateway.invoiceRequests).toEqual([]);
  });

  it("並行補辦同一張失敗的發票：只開立一張，只有一封通知", async () => {
    const { cookie, orderId, gateway, succeed } = await orderWithPayment();
    gateway.failNextInvoiceExplicitly();
    await app.applyPaymentResult(succeed());
    const [invoice] = await adminInvoices(orderId);

    await Promise.all([retry(invoice!.id), retry(invoice!.id), retry(invoice!.id)]);

    expect(gateway.invoices.size).toBe(1);
    expect(await myInvoices(cookie, orderId)).toMatchObject([{ status: "issued" }]);
    expect(await mailOf(cookie)).toHaveLength(1);
  });
});

describe("開立失敗不阻擋付款與出貨，可補辦", () => {
  it("明確失敗：付款成功、訂單已付款、仍可出貨；發票待辦列出、補辦成功後顧客看到發票並收到通知，再補辦冪等", async () => {
    const { cookie, orderId, totalTwd, gateway, succeed } = await orderWithPayment();
    gateway.failNextInvoiceExplicitly();

    await app.applyPaymentResult(succeed());

    const order = await orderOf(cookie, orderId);
    expect(order).toMatchObject({ status: "paid", payments: [{ status: "succeeded" }], invoices: [{ status: "failed", invoiceNumber: null, issuedAt: null, amountTwd: totalTwd }] });
    expect(await mailOf(cookie)).toEqual([]);
    expect(await shipRemaining(orderId)).toMatchObject({ ok: true });
    const listed = await todos();
    expect(listed.invoices).toMatchObject([{ id: order.invoices[0]!.id, orderId, status: "failed", attempts: [{ actor: "system", action: "send", outcome: "failed", code: "invoice_failed" }] }]);

    expect(await retry(order.invoices[0]!.id)).toEqual({ ok: true, data: { status: "issued" } });
    expect(await retry(order.invoices[0]!.id)).toEqual({ ok: true, data: { status: "issued" } });

    expect(await myInvoices(cookie, orderId)).toMatchObject([{ status: "issued", invoiceNumber: "SM-00000001", amountTwd: totalTwd }]);
    expect((await todos()).invoices).toEqual([]);
    expect(await mailOf(cookie)).toHaveLength(1);
    expect((await adminInvoices(orderId))[0]!.attempts.map((a) => [a.actor, a.action, a.outcome])).toEqual([["system", "send", "failed"], [ADMIN_EMAIL, "send", "succeeded"]]);
    expect(gateway.invoices.size).toBe(1);
  });

  it("發票服務拒絕請求（4xx）算明確失敗，5xx 與連不上算結果不明", async () => {
    const rejected = await orderWithPayment("alice");
    rejected.gateway.failNext("issueInvoice", 400);
    await app.applyPaymentResult(rejected.succeed());
    expect((await myInvoices(rejected.cookie, rejected.orderId))[0]!.status).toBe("failed");

    const unreachable = await orderWithPayment("bob", rejected.gateway);
    unreachable.gateway.failNext("issueInvoice", 0);
    await app.applyPaymentResult(unreachable.succeed());
    expect((await myInvoices(unreachable.cookie, unreachable.orderId))[0]!.status).toBe("unknown");
  });

  it("回應遺失（結果不明）：先查證，服務已開立就記成功，不重送、不重複開立", async () => {
    const { cookie, orderId, gateway, succeed } = await orderWithPayment();
    gateway.loseNextInvoiceResponse();

    await app.applyPaymentResult(succeed());

    const [invoice] = await adminInvoices(orderId);
    expect(invoice).toMatchObject({ status: "unknown", attempts: [{ action: "send", outcome: "unknown", code: "unreachable" }] });
    expect((await todos()).invoices).toMatchObject([{ id: invoice!.id, status: "unknown" }]);
    expect(gateway.invoiceRequests).toHaveLength(1);

    expect(await retry(invoice!.id)).toEqual({ ok: true, data: { status: "issued" } });

    expect(gateway.invoiceRequests).toHaveLength(1);
    expect(gateway.invoices.size).toBe(1);
    expect((await adminInvoices(orderId))[0]!.attempts.map((a) => [a.action, a.outcome])).toEqual([["send", "unknown"], ["verify", "succeeded"]]);
    expect(await mailOf(cookie)).toHaveLength(1);
  });

  it("結果不明且服務從未收過：查證記為未收過，接著以同一個冪等鍵送出", async () => {
    const { orderId, gateway, succeed } = await orderWithPayment();
    gateway.failNext("issueInvoice", 503);
    await app.applyPaymentResult(succeed());
    const [invoice] = await adminInvoices(orderId);

    expect(await retry(invoice!.id)).toEqual({ ok: true, data: { status: "issued" } });

    expect((await adminInvoices(orderId))[0]!.attempts.map((a) => [a.action, a.outcome])).toEqual([["send", "unknown"], ["verify", "not_found"], ["send", "succeeded"]]);
    expect(gateway.invoices.size).toBe(1);
  });

  it("查證本身失敗仍是結果不明，不送出", async () => {
    const { orderId, gateway, succeed } = await orderWithPayment();
    gateway.loseNextInvoiceResponse();
    await app.applyPaymentResult(succeed());
    const [invoice] = await adminInvoices(orderId);
    gateway.failNext("getInvoice", 503);

    expect(await retry(invoice!.id)).toEqual({ ok: true, data: { status: "unknown" } });

    expect(gateway.invoiceRequests).toHaveLength(1);
  });

  it("沒有閘道設定：補辦回 payment_unavailable，發票維持待開立；不存在的發票回 invoice_not_found", async () => {
    const { orderId, gateway, succeed } = await orderWithPayment();
    gateway.failNext("issueInvoice", 503);
    await app.applyPaymentResult(succeed());
    const [invoice] = await adminInvoices(orderId);

    const service = createInvoiceService(env.DB, { now: () => Date.now() }, null);

    expect(await service.retryInvoice(invoice!.id, ADMIN_EMAIL)).toEqual({ ok: false, reason: "payment_unavailable" });
    expect(await service.retryInvoice(999_999, ADMIN_EMAIL)).toEqual({ ok: false, reason: "payment_unavailable" });
    expect((await adminInvoices(orderId))[0]!.status).toBe("unknown");
    expect(await retry(999_999)).toEqual({ ok: false, reason: "invoice_not_found" });
  });

  it("發票服務回的金額與本站不符：不信任，結果當作不明", async () => {
    const { orderId, gateway, succeed } = await orderWithPayment();
    gateway.failNext("issueInvoice", 503);
    await app.applyPaymentResult(succeed());
    const [invoice] = await adminInvoices(orderId);
    const lying: InvoiceGateway = {
      getInvoice: async () => null,
      issueInvoice: async (input) => ({ ...input, amountTwd: input.amountTwd + 1, invoiceNumber: "SM-X", issuedAt: 1 }),
    };

    const service = createInvoiceService(env.DB, { now: () => Date.now() }, lying);

    expect(await service.retryInvoice(invoice!.id, ADMIN_EMAIL)).toEqual({ ok: true, data: { status: "unknown" } });
    expect((await adminInvoices(orderId))[0]).toMatchObject({ status: "unknown", invoiceNumber: null });
  });
});

describe("憑證重寄", () => {
  it("寄到顧客目前已驗證的 email：新增一筆投遞，歷史投遞與信件內容、發票都不變", async () => {
    const { cookie, orderId, succeed } = await orderWithPayment();
    await app.applyPaymentResult(succeed());
    const [before] = await adminInvoices(orderId);
    const [message] = await mailOf(cookie);
    const original = await app.getMyMail(cookie, { messageId: message!.id });
    const customerId = (await app.getCustomerSession(cookie)).customer!.customerId;
    await env.DB.prepare("INSERT INTO contact_verifications (customer_id, email, token, created_at, expires_at, verified_at) VALUES (?, 'new@example.com', 'tok-new', 5, 6, 5)").bind(customerId).run();

    expect(await app.resendInvoice(await mintAccessJwt(), { invoiceId: before!.id })).toEqual({ ok: true, data: { delivered: true } });

    const reopened = await app.getMyMail(cookie, { messageId: message!.id });
    expect(reopened.ok && reopened.data.deliveries.map((d) => d.recipientAddress)).toEqual(["contact-alice@example.com", "new@example.com"]);
    expect(reopened.ok && original.ok && [reopened.data.subject, reopened.data.body]).toEqual(original.ok && [original.data.subject, original.data.body]);
    expect((await adminInvoices(orderId))[0]).toEqual(before);
    expect(await mailOf(cookie)).toHaveLength(1);
  });

  it("沒有已驗證 email 回 no_verified_contact；尚未開立的發票沒有憑證可重寄；不存在回 invoice_not_found", async () => {
    const { cookie, orderId, gateway, succeed } = await orderWithPayment();
    gateway.failNextInvoiceExplicitly();
    await app.applyPaymentResult(succeed());
    const [pending] = await adminInvoices(orderId);
    const jwt = await mintAccessJwt();

    expect(await app.resendInvoice(jwt, { invoiceId: pending!.id })).toEqual({ ok: false, reason: "invoice_not_issued" });
    expect(await app.resendInvoice(jwt, { invoiceId: 999_999 })).toEqual({ ok: false, reason: "invoice_not_found" });

    await retry(pending!.id);
    await env.DB.prepare("DELETE FROM contact_verifications").run();
    expect(await app.resendInvoice(jwt, { invoiceId: pending!.id })).toEqual({ ok: false, reason: "no_verified_contact" });
    expect(cookie).toBeTruthy();
  });

  it("投遞失敗時信留在管理端待處理，不影響開立；重寄後送達", async () => {
    const jwt = await mintAccessJwt();
    const { cookie, orderId, succeed } = await orderWithPayment();
    await app.setMailDeliveryFailure(jwt, { enabled: true });

    await app.applyPaymentResult(succeed());

    expect(await myInvoices(cookie, orderId)).toMatchObject([{ status: "issued" }]);
    expect(await mailOf(cookie)).toEqual([]);
    await app.setMailDeliveryFailure(jwt, { enabled: false });
    const [invoice] = await adminInvoices(orderId);
    expect(await app.resendInvoice(jwt, { invoiceId: invoice!.id })).toEqual({ ok: true, data: { delivered: true } });
    expect(await mailOf(cookie)).toHaveLength(1);
  });
});

describe("權限隔離", () => {
  it("顧客讀不到別人的發票；管理 RPC 沒有有效 Access 身分一律 unauthorized", async () => {
    const alice = await orderWithPayment("alice");
    await app.applyPaymentResult(alice.succeed());
    const bob = await signInCustomer("bob");
    const [invoice] = await adminInvoices(alice.orderId);

    expect(await app.getMyOrder(bob, { orderId: alice.orderId })).toEqual({ ok: false, reason: "order_not_found" });
    expect(await mailOf(bob)).toEqual([]);
    expect(await app.getMyOrder("not-a-session", { orderId: alice.orderId })).toEqual({ ok: false, reason: "unauthorized" });
    expect(await app.listInvoicesToHandle("not-a-jwt")).toEqual({ ok: false, reason: "unauthorized" });
    expect(await app.retryInvoice("not-a-jwt", { invoiceId: invoice!.id })).toEqual({ ok: false, reason: "unauthorized" });
    expect(await app.resendInvoice("not-a-jwt", { invoiceId: invoice!.id })).toEqual({ ok: false, reason: "unauthorized" });
    expect(await app.retryInvoice(await mintAccessJwt(), { invoiceId: -1 })).toMatchObject({ ok: false, reason: "invalid_input" });
  });

  it("顧客檢視不含發票服務的冪等鍵與嘗試紀錄", async () => {
    const { cookie, orderId, gateway, succeed } = await orderWithPayment();
    gateway.failNextInvoiceExplicitly();
    await app.applyPaymentResult(succeed());

    const [invoice] = await myInvoices(cookie, orderId);

    expect(Object.keys(invoice!).sort()).toEqual(["amountTwd", "createdAt", "id", "invoiceNumber", "issuedAt", "paymentId", "pendingAllowanceCount", "pendingAllowanceTwd", "status"]);
  });
});

describe("待折讓義務：成功退款都建立，憑證待補、原票只顯示原額", () => {
  it("退款與開立同時成立：發票原額是整筆收款，待折讓義務是退款金額（不從原額扣除）；顧客與管理員都看得到", async () => {
    const { cookie, orderId, totalTwd, succeed } = await lateOrderWithPayment();

    await app.applyPaymentResult(succeed());

    const order = await orderOf(cookie, orderId);
    expect(order.refunds).toMatchObject([{ status: "succeeded", amountTwd: totalTwd }]);
    expect(order.invoices).toMatchObject([{ status: "issued", amountTwd: totalTwd, pendingAllowanceTwd: totalTwd, pendingAllowanceCount: 1 }]);
    const [admin] = await adminInvoices(orderId);
    expect(admin).toMatchObject({ allowances: [{ refundId: order.refunds[0]!.id, amountTwd: totalTwd }] });
    expect((await todos()).allowances).toMatchObject([{ orderId, refundId: order.refunds[0]!.id, amountTwd: totalTwd, invoiceStatus: "issued" }]);
  });

  it("退款先於延遲開立的發票成功：先保留退款與義務，原票補開後仍是原額，義務不變不重複", async () => {
    const { cookie, orderId, totalTwd, gateway, succeed } = await lateOrderWithPayment();
    gateway.loseNextInvoiceResponse();

    await app.applyPaymentResult(succeed());

    const before = await orderOf(cookie, orderId);
    expect(before.refunds).toMatchObject([{ status: "succeeded" }]);
    expect(before.invoices).toMatchObject([{ status: "unknown", invoiceNumber: null, amountTwd: totalTwd, pendingAllowanceTwd: totalTwd }]);
    await retry(before.invoices[0]!.id);
    await retry(before.invoices[0]!.id);
    expect((await orderOf(cookie, orderId)).invoices).toMatchObject([{ status: "issued", amountTwd: totalTwd, pendingAllowanceTwd: totalTwd, pendingAllowanceCount: 1 }]);
  });

  it("後續成功的退款（失敗後重試成功）才建立義務，重試與重複只算一次", async () => {
    const { cookie, orderId, totalTwd, gateway, succeed } = await lateOrderWithPayment();
    gateway.failNextRefundExplicitly();
    await app.applyPaymentResult(succeed());
    const [invoice] = await myInvoices(cookie, orderId);
    expect(invoice).toMatchObject({ status: "issued", pendingAllowanceTwd: 0, pendingAllowanceCount: 0 });
    const refundId = (await orderOf(cookie, orderId)).refunds[0]!.id;

    await app.retryRefund(await mintAccessJwt(), { refundId });
    await app.retryRefund(await mintAccessJwt(), { refundId });

    expect((await myInvoices(cookie, orderId))[0]).toMatchObject({ amountTwd: totalTwd, pendingAllowanceTwd: totalTwd, pendingAllowanceCount: 1 });
    expect(await env.DB.prepare("SELECT refund_id, amount_twd FROM allowance_obligations").all()).toMatchObject({ results: [{ refund_id: refundId, amount_twd: totalTwd }] });
  });

  it("沒有成功的退款就沒有義務：退款失敗或不明時不建立", async () => {
    const { cookie, orderId, gateway, succeed } = await lateOrderWithPayment();
    gateway.failNextRefundExplicitly();

    await app.applyPaymentResult(succeed());

    expect((await myInvoices(cookie, orderId))[0]).toMatchObject({ pendingAllowanceTwd: 0, pendingAllowanceCount: 0 });
    expect((await todos()).allowances).toEqual([]);
  });

  it("退款沒有真的轉為成功（租約已不是自己的）時不建立義務，也不寄退款通知", async () => {
    const { orderId, gateway, succeed } = await lateOrderWithPayment();
    gateway.failNextRefundExplicitly();
    await app.applyPaymentResult(succeed());
    const [refund] = (await app.getOrderForAdmin(await mintAccessJwt(), { orderId }) as { ok: true; data: { refunds: { id: number }[] } }).data.refunds;

    const written = await recordRefundAttempt(env.DB, { refundId: refund!.id, claimedAt: 12345, actor: "system", action: "send", outcome: "succeeded", code: null, status: "succeeded" }, Date.now());

    expect(written).toBe(false);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM allowance_obligations").first<{ n: number }>()).toEqual({ n: 0 });
  });

  it("其他人的待折讓義務不出現在顧客的發票上", async () => {
    const alice = await lateOrderWithPayment();
    await app.applyPaymentResult(alice.succeed());
    const bob = await orderWithPayment("bob", alice.gateway);
    await app.applyPaymentResult(bob.succeed());

    expect((await myInvoices(bob.cookie, bob.orderId))[0]).toMatchObject({ pendingAllowanceTwd: 0, pendingAllowanceCount: 0 });
    // 管理員的單張訂單與待折讓清單同樣只算各自收款的義務
    expect((await adminInvoices(bob.orderId))[0]).toMatchObject({ pendingAllowanceTwd: 0, pendingAllowanceCount: 0, allowances: [] });
    expect((await adminInvoices(alice.orderId))[0]).toMatchObject({ pendingAllowanceCount: 1 });
    expect((await todos()).allowances).toMatchObject([{ orderId: alice.orderId, invoiceStatus: "issued" }]);
  });
});

describe("每筆收款一張發票", () => {
  it("同一張訂單上兩筆成功付款各一張發票、各自原額；同一筆收款不會有第二張（唯一索引）", async () => {
    const { orderId, totalTwd, gateway, succeed } = await lateOrderWithPayment();
    const second = await seedPayment(orderId, "pending", "pay_second", totalTwd);
    gateway.adopt(second, { amountTwd: totalTwd, merchantReference: String(orderId) });

    await app.applyPaymentResult(succeed());
    await app.applyPaymentResult(gateway.settle(second, "succeeded"));

    const invoices = await adminInvoices(orderId);
    expect(invoices.map((invoice) => [invoice.status, invoice.amountTwd])).toEqual([["issued", totalTwd], ["issued", totalTwd]]);
    expect(new Set(invoices.map((invoice) => invoice.paymentId)).size).toBe(2);
    await expect(env.DB.prepare("INSERT INTO invoices (order_id, payment_id, gateway_invoice_key, amount_twd, created_at) VALUES (?, ?, 'inv_dup', 1, 0)").bind(orderId, invoices[0]!.paymentId).run()).rejects.toThrow(/UNIQUE/);
  });
});
