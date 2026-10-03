import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { recordAllowanceAttempt } from "../src/invoices/allowance-queries";
import type { InvoiceGateway } from "../src/invoices/gateway";
import { createInvoiceService } from "../src/invoices/service";
import { GatewayError } from "../src/payments/gateway";
import { ADMIN_EMAIL, mintAccessJwt } from "./access";
import { signInCustomer } from "./customers";
import { forceOrderStatus, resetDb } from "./db";
import { installFakeGateway } from "./fake-gateway";
import { orderOf, placeMugOrder, startPaymentFor } from "./payment-helpers";
import { app } from "./release-helpers";

beforeEach(resetDb);

/** 已取消訂單上的遲到付款：付款成功會登記整筆退款，退款成功就有一筆待折讓義務。 */
async function lateOrderWithPayment(name = "alice", gateway = installFakeGateway()) {
  const cookie = await signInCustomer(name);
  const { orderId, totalTwd } = await placeMugOrder(cookie);
  const gatewayPaymentId = await startPaymentFor(cookie, orderId, gateway);
  await forceOrderStatus(orderId, "cancelled");
  return { cookie, orderId, totalTwd, gateway, succeed: () => gateway.settle(gatewayPaymentId, "succeeded") };
}

const adminInvoice = async (orderId: number) => {
  const found = await app.getOrderForAdmin(await mintAccessJwt(), { orderId });
  if (!found.ok) throw new Error("讀取訂單失敗");
  return found.data.invoices[0]!;
};
const todoAllowances = async () => {
  const listed = await app.listInvoicesToHandle(await mintAccessJwt());
  if (!listed.ok) throw new Error("讀取發票待辦失敗");
  return listed.data.allowances;
};
const retryAllowance = async (refundId: number) => app.retryAllowance(await mintAccessJwt(), { refundId });
const retryInvoice = async (invoiceId: number) => app.retryInvoice(await mintAccessJwt(), { invoiceId });
const allowanceMail = async (cookie: string) => {
  const list = await app.listMyMail(cookie);
  if (!list.ok) throw new Error("讀信失敗");
  return list.data.filter((message) => message.kind === "allowance_issued");
};
const refundIdOf = async (cookie: string, orderId: number) => (await orderOf(cookie, orderId)).refunds[0]!.id;

describe("成功退款逐筆折讓", () => {
  it("原票已開立：退款成功後折讓一次，原額不變、顧客看到累計折讓與餘額、收到折讓通知、待辦沒有這筆", async () => {
    const { cookie, orderId, totalTwd, gateway, succeed } = await lateOrderWithPayment();

    await app.applyPaymentResult(succeed());

    const [invoice] = (await orderOf(cookie, orderId)).invoices;
    expect(invoice).toMatchObject({ status: "issued", amountTwd: totalTwd, allowedTwd: totalTwd, allowedCount: 1, pendingAllowanceTwd: 0, pendingAllowanceCount: 0 });
    expect(gateway.allowanceRequests).toEqual([{ invoiceKey: expect.stringMatching(/^inv_/), allowanceKey: expect.stringMatching(/^alw_/), amountTwd: totalTwd }]);
    const refundId = await refundIdOf(cookie, orderId);
    expect(await adminInvoice(orderId)).toMatchObject({ allowances: [{ refundId, amountTwd: totalTwd, status: "issued", allowanceNumber: "SA-00000001", issuedAt: expect.any(Number), attempts: [{ actor: "system", action: "send", outcome: "succeeded" }] }] });
    expect(await todoAllowances()).toEqual([]);
    const [message] = await allowanceMail(cookie);
    expect(message).toMatchObject({ kind: "allowance_issued", recipientAddress: "contact-alice@example.com" });
    const opened = await app.getMyMail(cookie, { messageId: message!.id });
    expect(opened.ok && opened.data.body).toContain("SA-00000001");
    expect(opened.ok && opened.data.body).toContain(`NT$${totalTwd}`);
  });

  it("退款先成功、原票延遲未完成：保留退款與待折讓義務、不送出折讓；原票補辦成功後自動補折讓，不必有人手動", async () => {
    const { cookie, orderId, totalTwd, gateway, succeed } = await lateOrderWithPayment();
    gateway.loseNextInvoiceResponse();

    await app.applyPaymentResult(succeed());

    const before = await orderOf(cookie, orderId);
    expect(before.refunds).toMatchObject([{ status: "succeeded", amountTwd: totalTwd }]);
    expect(before.invoices).toMatchObject([{ status: "unknown", allowedTwd: 0, pendingAllowanceTwd: totalTwd, pendingAllowanceCount: 1 }]);
    expect(gateway.allowanceRequests).toEqual([]);
    expect(await adminInvoice(orderId)).toMatchObject({ allowances: [{ status: "pending", allowanceNumber: null, attempts: [] }] });
    expect(await todoAllowances()).toMatchObject([{ orderId, amountTwd: totalTwd, status: "pending", invoiceStatus: "unknown" }]);
    // 原票未開立：管理員也不能先折讓
    expect(await retryAllowance(before.refunds[0]!.id)).toEqual({ ok: false, reason: "invoice_not_issued" });
    expect(gateway.allowanceRequests).toEqual([]);

    expect(await retryInvoice(before.invoices[0]!.id)).toEqual({ ok: true, data: { status: "issued" } });

    expect((await orderOf(cookie, orderId)).invoices).toMatchObject([{ status: "issued", allowedTwd: totalTwd, pendingAllowanceCount: 0 }]);
    expect(gateway.allowanceRequests).toHaveLength(1);
    expect(await todoAllowances()).toEqual([]);
    expect(await allowanceMail(cookie)).toHaveLength(1);
  });

  it("原票開立明確失敗：退款不被阻擋，折讓等著；原票補辦成功後折讓", async () => {
    const { cookie, orderId, totalTwd, gateway, succeed } = await lateOrderWithPayment();
    gateway.failNextInvoiceExplicitly();

    await app.applyPaymentResult(succeed());

    expect((await orderOf(cookie, orderId)).refunds).toMatchObject([{ status: "succeeded" }]);
    expect(gateway.allowanceRequests).toEqual([]);
    expect(gateway.allowances.size).toBe(0);
    await retryInvoice((await adminInvoice(orderId)).id);
    expect((await orderOf(cookie, orderId)).invoices).toMatchObject([{ allowedTwd: totalTwd, pendingAllowanceCount: 0 }]);
    expect(gateway.allowances.size).toBe(1);
  });

  it("同筆成功退款只折讓一次：付款事件重送、退款重試、並行補辦都回同一張折讓、同一個冪等鍵、一封通知", async () => {
    const { cookie, orderId, gateway, succeed } = await lateOrderWithPayment();
    const event = succeed();
    await app.applyPaymentResult(event);
    const refundId = await refundIdOf(cookie, orderId);

    await app.applyPaymentResult(event);
    await app.applyPaymentResult({ ...event, eventId: "evt_other" });
    await app.retryRefund(await mintAccessJwt(), { refundId });
    await Promise.all([retryAllowance(refundId), retryAllowance(refundId), retryAllowance(refundId)]);
    await retryInvoice((await adminInvoice(orderId)).id);

    expect(gateway.allowances.size).toBe(1);
    expect(new Set(gateway.allowanceRequests.map((request) => request.allowanceKey)).size).toBe(1);
    expect(await allowanceMail(cookie)).toHaveLength(1);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM allowance_obligations").first<{ n: number }>()).toEqual({ n: 1 });
  });
});

describe("折讓失敗與延遲可查證、可補辦", () => {
  it("明確失敗：退款與原票不受影響，待辦列出；補辦成功後顧客看到折讓並收到通知，再補辦冪等", async () => {
    const { cookie, orderId, totalTwd, gateway, succeed } = await lateOrderWithPayment();
    gateway.failNextAllowanceExplicitly();

    await app.applyPaymentResult(succeed());

    const order = await orderOf(cookie, orderId);
    expect(order.refunds).toMatchObject([{ status: "succeeded" }]);
    expect(order.invoices).toMatchObject([{ status: "issued", allowedTwd: 0, pendingAllowanceTwd: totalTwd, pendingAllowanceCount: 1 }]);
    expect(await allowanceMail(cookie)).toEqual([]);
    const refundId = order.refunds[0]!.id;
    expect(await todoAllowances()).toMatchObject([{ refundId, status: "failed", invoiceStatus: "issued", attempts: [{ actor: "system", action: "send", outcome: "failed", code: "allowance_failed" }] }]);

    expect(await retryAllowance(refundId)).toEqual({ ok: true, data: { status: "issued" } });
    expect(await retryAllowance(refundId)).toEqual({ ok: true, data: { status: "issued" } });

    expect((await orderOf(cookie, orderId)).invoices).toMatchObject([{ allowedTwd: totalTwd, pendingAllowanceCount: 0 }]);
    expect(await todoAllowances()).toEqual([]);
    expect(await allowanceMail(cookie)).toHaveLength(1);
    expect((await adminInvoice(orderId)).allowances[0]!.attempts.map((a) => [a.actor, a.action, a.outcome])).toEqual([["system", "send", "failed"], [ADMIN_EMAIL, "send", "succeeded"]]);
    expect(gateway.allowances.size).toBe(1);
  });

  it("回應遺失（結果不明）：先查證，服務已折讓就記成功，不重送、不重複折讓", async () => {
    const { cookie, orderId, gateway, succeed } = await lateOrderWithPayment();
    gateway.loseNextAllowanceResponse();

    await app.applyPaymentResult(succeed());

    const refundId = await refundIdOf(cookie, orderId);
    expect(await todoAllowances()).toMatchObject([{ refundId, status: "unknown", attempts: [{ action: "send", outcome: "unknown", code: "unreachable" }] }]);
    expect(gateway.allowanceRequests).toHaveLength(1);

    expect(await retryAllowance(refundId)).toEqual({ ok: true, data: { status: "issued" } });

    expect(gateway.allowanceRequests).toHaveLength(1);
    expect(gateway.allowances.size).toBe(1);
    expect((await adminInvoice(orderId)).allowances[0]!.attempts.map((a) => [a.action, a.outcome])).toEqual([["send", "unknown"], ["verify", "succeeded"]]);
    expect(await allowanceMail(cookie)).toHaveLength(1);
  });

  it("結果不明且服務從未收過：查證記為未收過，接著以同一個冪等鍵送出", async () => {
    const { cookie, orderId, gateway, succeed } = await lateOrderWithPayment();
    gateway.failNext("issueAllowance", 503);
    await app.applyPaymentResult(succeed());
    const refundId = await refundIdOf(cookie, orderId);

    expect(await retryAllowance(refundId)).toEqual({ ok: true, data: { status: "issued" } });

    expect((await adminInvoice(orderId)).allowances[0]!.attempts.map((a) => [a.action, a.outcome])).toEqual([["send", "unknown"], ["verify", "not_found"], ["send", "succeeded"]]);
    expect(gateway.allowances.size).toBe(1);
  });

  it("查證本身失敗仍是結果不明，不送出", async () => {
    const { cookie, orderId, gateway, succeed } = await lateOrderWithPayment();
    gateway.loseNextAllowanceResponse();
    await app.applyPaymentResult(succeed());
    gateway.failNext("getAllowance", 503);

    expect(await retryAllowance(await refundIdOf(cookie, orderId))).toEqual({ ok: true, data: { status: "unknown" } });

    expect(gateway.allowanceRequests).toHaveLength(1);
  });

  it("發票服務拒絕折讓額度（累計超過原額，422）算明確失敗，可補辦", async () => {
    const { cookie, orderId, totalTwd, gateway, succeed } = await lateOrderWithPayment();
    gateway.failNextAllowanceExplicitly();
    await app.applyPaymentResult(succeed());
    const refundId = await refundIdOf(cookie, orderId);
    // 發票服務上這張發票的額度先被別的折讓用完
    const [invoiceKey] = [...gateway.invoices.keys()];
    gateway.allowances.set("alw_other", { allowanceKey: "alw_other", invoiceKey: invoiceKey!, allowanceNumber: "SA-OTHER", amountTwd: totalTwd, issuedAt: 1 });

    expect(await retryAllowance(refundId)).toEqual({ ok: true, data: { status: "failed" } });

    expect((await adminInvoice(orderId)).allowances[0]!.attempts.at(-1)).toMatchObject({ outcome: "failed", code: "allowance_exceeds_invoice" });
    expect((await orderOf(cookie, orderId)).invoices).toMatchObject([{ allowedTwd: 0, pendingAllowanceCount: 1 }]);
  });

  it("服務回 409 allowance_conflict 或回應與本站不符：記為結果不明，不當作明確失敗", async () => {
    const { cookie, orderId, gateway, succeed } = await lateOrderWithPayment();
    gateway.failNextAllowanceExplicitly();
    await app.applyPaymentResult(succeed());
    const refundId = await refundIdOf(cookie, orderId);
    const base = { getInvoice: async () => null, issueInvoice: async (): Promise<never> => { throw new Error("不該開立"); }, getAllowance: async () => null };
    const conflicting: InvoiceGateway = {
      ...base,
      issueAllowance: async () => {
        throw new GatewayError("allowance_conflict", 409, "衝突");
      },
    };
    const lying: InvoiceGateway = { ...base, issueAllowance: async (input) => ({ ...input, amountTwd: input.amountTwd + 1, allowanceNumber: "SA-X", issuedAt: 1 }) };

    expect(await createInvoiceService(env.DB, { now: () => Date.now() }, conflicting).retryAllowance(refundId, ADMIN_EMAIL)).toEqual({ ok: true, data: { status: "unknown" } });
    expect((await adminInvoice(orderId)).allowances[0]!.attempts.at(-1)).toMatchObject({ outcome: "unknown", code: "allowance_conflict" });
    expect(await createInvoiceService(env.DB, { now: () => Date.now() }, lying).retryAllowance(refundId, ADMIN_EMAIL)).toEqual({ ok: true, data: { status: "unknown" } });
    expect((await adminInvoice(orderId)).allowances[0]).toMatchObject({ status: "unknown", allowanceNumber: null });
  });

  it("沒有閘道設定：補辦回 payment_unavailable，義務不動；不存在回 allowance_not_found", async () => {
    const { cookie, orderId, gateway, succeed } = await lateOrderWithPayment();
    gateway.failNextAllowanceExplicitly();
    await app.applyPaymentResult(succeed());
    const refundId = await refundIdOf(cookie, orderId);

    const service = createInvoiceService(env.DB, { now: () => Date.now() }, null);

    expect(await service.retryAllowance(refundId, ADMIN_EMAIL)).toEqual({ ok: false, reason: "payment_unavailable" });
    expect((await adminInvoice(orderId)).allowances[0]!.status).toBe("failed");
    expect(await retryAllowance(999_999)).toEqual({ ok: false, reason: "allowance_not_found" });
  });

  it("已折讓後再記失敗或不明：狀態、號碼與折讓時間不變，通知不重複", async () => {
    const { cookie, orderId, succeed } = await lateOrderWithPayment();
    await app.applyPaymentResult(succeed());
    const before = (await adminInvoice(orderId)).allowances[0]!;
    const allowanceId = (await env.DB.prepare("SELECT id FROM allowance_obligations").first<{ id: number }>())!.id;

    for (const status of ["failed", "unknown"] as const) {
      expect(await recordAllowanceAttempt(env.DB, { allowanceId, refundId: before.refundId, actor: "system", action: "send", outcome: status, code: "x", status }, Date.now())).toBe(false);
    }

    expect((await adminInvoice(orderId)).allowances[0]).toMatchObject({ status: "issued", allowanceNumber: before.allowanceNumber, issuedAt: before.issuedAt });
    expect(await allowanceMail(cookie)).toHaveLength(1);
  });
});

describe("折讓通知可重送", () => {
  it("重寄到顧客目前已驗證的 email：新增一筆投遞，信件內容不變；尚未折讓回 allowance_not_issued，不存在回 allowance_not_found", async () => {
    const jwt = await mintAccessJwt();
    const { cookie, orderId, gateway, succeed } = await lateOrderWithPayment();
    gateway.failNextAllowanceExplicitly();
    await app.applyPaymentResult(succeed());
    const refundId = await refundIdOf(cookie, orderId);
    expect(await app.resendAllowance(jwt, { refundId })).toEqual({ ok: false, reason: "allowance_not_issued" });
    expect(await app.resendAllowance(jwt, { refundId: 999_999 })).toEqual({ ok: false, reason: "allowance_not_found" });
    await retryAllowance(refundId);
    const [message] = await allowanceMail(cookie);
    const original = await app.getMyMail(cookie, { messageId: message!.id });

    expect(await app.resendAllowance(jwt, { refundId })).toEqual({ ok: true, data: { delivered: true } });

    const reopened = await app.getMyMail(cookie, { messageId: message!.id });
    expect(reopened.ok && reopened.data.deliveries).toHaveLength(2);
    expect(reopened.ok && original.ok && reopened.data.body).toBe(original.ok && original.data.body);
    expect(await allowanceMail(cookie)).toHaveLength(1);
  });

  it("首次投遞失敗（通知遺失）：折讓照樣完成，信留在管理端；重寄後送達", async () => {
    const jwt = await mintAccessJwt();
    const { cookie, orderId, succeed } = await lateOrderWithPayment();
    await app.setMailDeliveryFailure(jwt, { enabled: true });

    await app.applyPaymentResult(succeed());

    expect((await orderOf(cookie, orderId)).invoices).toMatchObject([{ allowedCount: 1 }]);
    expect(await allowanceMail(cookie)).toEqual([]);
    await app.setMailDeliveryFailure(jwt, { enabled: false });
    expect(await app.resendAllowance(jwt, { refundId: await refundIdOf(cookie, orderId) })).toEqual({ ok: true, data: { delivered: true } });
    expect(await allowanceMail(cookie)).toHaveLength(1);
  });
});

describe("權限隔離", () => {
  it("顧客只看得到自己訂單上的折讓；折讓 RPC 沒有有效 Access 身分一律 unauthorized、輸入不合法回 invalid_input", async () => {
    const alice = await lateOrderWithPayment("alice");
    await app.applyPaymentResult(alice.succeed());
    const bob = await signInCustomer("bob");
    const refundId = await refundIdOf(alice.cookie, alice.orderId);

    expect(await app.getMyOrder(bob, { orderId: alice.orderId })).toEqual({ ok: false, reason: "order_not_found" });
    expect(await allowanceMail(bob)).toEqual([]);
    expect(await app.retryAllowance("not-a-jwt", { refundId })).toEqual({ ok: false, reason: "unauthorized" });
    expect(await app.resendAllowance("not-a-jwt", { refundId })).toEqual({ ok: false, reason: "unauthorized" });
    expect(await app.retryAllowance(await mintAccessJwt(), { refundId: -1 })).toMatchObject({ ok: false, reason: "invalid_input" });
    expect(await app.resendAllowance(await mintAccessJwt(), { refundId: "x" })).toMatchObject({ ok: false, reason: "invalid_input" });
  });

  it("別人的折讓不算進自己收款的發票", async () => {
    const alice = await lateOrderWithPayment("alice");
    await app.applyPaymentResult(alice.succeed());
    const bobCookie = await signInCustomer("bob");
    const bob = await placeMugOrder(bobCookie);
    const bobPayment = await startPaymentFor(bobCookie, bob.orderId, alice.gateway);
    await app.applyPaymentResult(alice.gateway.settle(bobPayment, "succeeded"));

    expect((await orderOf(bobCookie, bob.orderId)).invoices).toMatchObject([{ allowedTwd: 0, allowedCount: 0, pendingAllowanceCount: 0 }]);
    expect((await adminInvoice(bob.orderId)).allowances).toEqual([]);
  });
});
