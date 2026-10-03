import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { mintAccessJwt } from "./access";
import { setNow } from "./clock";
import { checkoutInput, createStockedListing } from "./checkout-helpers";
import { signInCustomer } from "./customers";
import { forceOrderStatus, resetDb } from "./db";
import { installFakeGateway } from "./fake-gateway";
import { placeMugOrder, startPaymentFor } from "./payment-helpers";
import { app } from "./release-helpers";

const NOW = Date.UTC(2026, 9, 3, 2, 0, 0);

beforeEach(async () => {
  await resetDb();
  setNow(NOW);
});

async function mailOf(cookie: string) {
  const list = await app.listMyMail(cookie);
  if (!list.ok) throw new Error("讀信失敗");
  return list.data;
}

async function adminMail() {
  const result = await app.listMailForAdmin(await mintAccessJwt());
  if (!result.ok) throw new Error("管理員讀不到信件");
  return result.data;
}

const kindsOf = (messages: { kind: string }[]) => messages.map((message) => message.kind).sort();

describe("下單通知", () => {
  it("下單後寄到下單當下已驗證的地址；同一個冪等鍵重送不重複寄信", async () => {
    const alice = await signInCustomer("alice");
    const { variantId } = await createStockedListing("馬克杯", 320, 10);
    const input = checkoutInput([{ variantId, quantity: 2, seenUnitPriceTwd: 320 }]);

    const placed = await app.checkout(alice, input);
    if (!placed.ok) throw new Error("結帳失敗");
    await app.checkout(alice, input);

    const mail = await mailOf(alice);
    expect(mail).toHaveLength(1);
    expect(mail[0]).toMatchObject({ kind: "order_placed", recipientAddress: "contact-alice@example.com" });
    const opened = await app.getMyMail(alice, { messageId: mail[0]!.id });
    expect(opened).toMatchObject({ ok: true, data: { body: expect.stringContaining(`#${placed.data.orderId}`) } });
  });

  it("投遞失敗不影響下單：訂單成立、信在管理端待處理，重送後送達並留下處理人", async () => {
    const jwt = await mintAccessJwt();
    const alice = await signInCustomer("alice");
    await app.setMailDeliveryFailure(jwt, { enabled: true });

    const { orderId } = await placeMugOrder(alice);

    expect((await app.getMyOrder(alice, { orderId })).ok).toBe(true);
    expect(await mailOf(alice)).toEqual([]);
    const [pending] = (await adminMail()).messages;
    expect(pending).toMatchObject({ kind: "order_placed", needsAttention: true, deliveries: [{ status: "failed", handledBy: null }] });

    await app.setMailDeliveryFailure(jwt, { enabled: false });
    expect(await app.resendMail(jwt, { messageId: pending!.id })).toEqual({ ok: true, data: { delivered: true } });

    const [resolved] = (await adminMail()).messages;
    expect(resolved).toMatchObject({ needsAttention: false });
    expect(resolved!.deliveries.map((d) => [d.status, d.handledBy])).toEqual([["failed", null], ["delivered", expect.any(String)]]);
    expect(await mailOf(alice)).toHaveLength(1);
  });

  it("換了聯絡 email 之後：舊信的重送寄新地址，歷史投遞保留原地址", async () => {
    const jwt = await mintAccessJwt();
    const alice = await signInCustomer("alice");
    const { orderId } = await placeMugOrder(alice);
    const customerId = (await app.getCustomerSession(alice)).customer!.customerId;
    await env.DB.prepare("INSERT INTO contact_verifications (customer_id, email, token, created_at, expires_at, verified_at) VALUES (?, 'new@example.com', 'tok-new', 5, 6, 5)").bind(customerId).run();
    const [message] = (await adminMail()).messages;

    await app.resendMail(jwt, { messageId: message!.id });

    const mail = await app.getMyMail(alice, { messageId: message!.id });
    expect(mail).toMatchObject({ ok: true, data: { deliveries: [{ recipientAddress: "contact-alice@example.com" }, { recipientAddress: "new@example.com" }] } });
    expect(orderId).toBeGreaterThan(0);
  });

  it("舊訂單的顧客沒有已驗證 email：通知先留在待處理，驗證後可重送", async () => {
    const jwt = await mintAccessJwt();
    const alice = await signInCustomer("alice");
    const { orderId } = await placeMugOrder(alice);
    await env.DB.prepare("DELETE FROM mail_deliveries").run();
    await env.DB.prepare("DELETE FROM mail_messages").run();
    await env.DB.prepare("DELETE FROM contact_verifications").run();

    const gateway = installFakeGateway();
    await startPaymentFor(alice, orderId, gateway);
    gateway.settle(gateway.lastPaymentId(), "succeeded");
    await app.confirmPayment(alice, { orderId, gatewayPaymentId: gateway.lastPaymentId() });

    const message = (await adminMail()).messages.find((candidate) => candidate.kind === "payment_succeeded");
    expect(message).toMatchObject({ kind: "payment_succeeded", needsAttention: true, deliveries: [] });
    expect(await app.resendMail(jwt, { messageId: message!.id })).toEqual({ ok: false, reason: "no_verified_contact" });

    const customerId = (await app.getCustomerSession(alice)).customer!.customerId;
    await env.DB.prepare("INSERT INTO contact_verifications (customer_id, email, token, created_at, expires_at, verified_at) VALUES (?, 'late@example.com', 'tok-late', 5, 6, 5)").bind(customerId).run();
    expect(await app.resendMail(jwt, { messageId: message!.id })).toEqual({ ok: true, data: { delivered: true } });
    expect((await mailOf(alice)).find((candidate) => candidate.kind === "payment_succeeded")).toMatchObject({ recipientAddress: "late@example.com" });
  });

  it("投遞階段丟例外時下單仍成功，信件已存在並出現在待辦；同一冪等鍵重送補回首次投遞", async () => {
    const alice = await signInCustomer("alice");
    const { variantId } = await createStockedListing("馬克杯", 320, 10);
    const input = checkoutInput([{ variantId, quantity: 1, seenUnitPriceTwd: 320 }]);
    await env.DB.prepare("CREATE TRIGGER fail_delivery BEFORE INSERT ON mail_deliveries BEGIN SELECT RAISE(ABORT, 'boom'); END").run();
    let placed;
    try {
      placed = await app.checkout(alice, input);
    } finally {
      await env.DB.prepare("DROP TRIGGER fail_delivery").run();
    }

    expect(placed).toMatchObject({ ok: true });
    expect(await mailOf(alice)).toEqual([]);
    expect((await adminMail()).messages).toMatchObject([{ kind: "order_placed", needsAttention: true, deliveries: [] }]);

    await app.checkout(alice, input);
    await app.checkout(alice, input);
    expect(await mailOf(alice)).toHaveLength(1);
    expect((await adminMail()).messages).toMatchObject([{ needsAttention: false, deliveries: [{ status: "delivered" }] }]);
  });

  it("刪掉首次投遞後，以同一冪等鍵 checkout 補回，不新增信件", async () => {
    const alice = await signInCustomer("alice");
    const { variantId } = await createStockedListing("馬克杯", 320, 10);
    const input = checkoutInput([{ variantId, quantity: 1, seenUnitPriceTwd: 320 }]);
    await app.checkout(alice, input);
    await env.DB.prepare("DELETE FROM mail_deliveries").run();
    expect(await mailOf(alice)).toEqual([]);

    await app.checkout(alice, input);

    expect(await mailOf(alice)).toHaveLength(1);
    expect((await adminMail()).messages).toHaveLength(1);
  });
});

describe("付款結果通知", () => {
  async function paidSetup() {
    const alice = await signInCustomer("alice");
    const { orderId } = await placeMugOrder(alice);
    const gateway = installFakeGateway();
    const gatewayPaymentId = await startPaymentFor(alice, orderId, gateway);
    return { alice, orderId, gateway, gatewayPaymentId };
  }

  it("付款成功寄一封通知；webhook 重送與導回查詢重複套用都不再寄信", async () => {
    const { alice, orderId, gateway, gatewayPaymentId } = await paidSetup();
    const event = gateway.settle(gatewayPaymentId, "succeeded");

    await app.applyPaymentResult(event);
    await app.applyPaymentResult(event);
    await app.confirmPayment(alice, { orderId, gatewayPaymentId });

    expect(kindsOf(await mailOf(alice))).toEqual(["invoice_issued", "order_placed", "payment_succeeded"]);
  });

  it("付款失敗寄失敗通知，訂單仍待付款", async () => {
    const { alice, orderId, gateway, gatewayPaymentId } = await paidSetup();

    await app.applyPaymentResult(gateway.settle(gatewayPaymentId, "failed"));

    expect(kindsOf(await mailOf(alice))).toEqual(["order_placed", "payment_failed"]);
    expect((await app.getMyOrder(alice, { orderId }))).toMatchObject({ ok: true, data: { status: "pending_payment" } });
  });

  it("遲到付款（訂單已取消而退款）寄一封未生效通知與一封退款通知，重送不重複", async () => {
    const { alice, orderId, gateway, gatewayPaymentId } = await paidSetup();
    await forceOrderStatus(orderId, "cancelled");
    const event = gateway.settle(gatewayPaymentId, "succeeded");

    await app.applyPaymentResult(event);
    await app.applyPaymentResult(event);

    expect(kindsOf(await mailOf(alice))).toEqual(["invoice_issued", "order_placed", "payment_unsettled", "refund_succeeded"]);
  });

  it("通知投遞失敗不讓付款失敗：訂單照常轉為已付款，信留在待處理", async () => {
    const jwt = await mintAccessJwt();
    const { alice, orderId, gateway, gatewayPaymentId } = await paidSetup();
    await app.setMailDeliveryFailure(jwt, { enabled: true });

    const result = await app.applyPaymentResult(gateway.settle(gatewayPaymentId, "succeeded"));

    expect(result).toMatchObject({ ok: true, data: { orderStatus: "paid" } });
    expect((await app.getMyOrder(alice, { orderId }))).toMatchObject({ ok: true, data: { status: "paid" } });
    const pending = (await adminMail()).messages.filter((message) => message.needsAttention);
    expect(pending.map((message) => message.kind).sort()).toEqual(["invoice_issued", "payment_succeeded"]);
  });

  it("付款投遞階段丟例外時付款仍成功，信件已存在並出現在待辦", async () => {
    const { alice, orderId, gateway, gatewayPaymentId } = await paidSetup();
    await env.DB.prepare("CREATE TRIGGER fail_delivery BEFORE INSERT ON mail_deliveries BEGIN SELECT RAISE(ABORT, 'boom'); END").run();
    let result;
    try {
      result = await app.applyPaymentResult(gateway.settle(gatewayPaymentId, "succeeded"));
    } finally {
      await env.DB.prepare("DROP TRIGGER fail_delivery").run();
    }

    expect(result).toMatchObject({ ok: true, data: { orderStatus: "paid" } });
    expect((await app.getMyOrder(alice, { orderId }))).toMatchObject({ ok: true, data: { status: "paid" } });
    const pending = (await adminMail()).messages.filter((message) => message.needsAttention);
    expect(pending.map((message) => message.kind).sort()).toEqual(["invoice_issued", "payment_succeeded"]);
    expect(pending.every((message) => message.deliveries.length === 0)).toBe(true);
  });

  it("通知遺失後，事件重送會補上缺的那封，仍不重複", async () => {
    const { alice, gateway, gatewayPaymentId } = await paidSetup();
    const event = gateway.settle(gatewayPaymentId, "succeeded");
    await app.applyPaymentResult(event);
    await env.DB.prepare("DELETE FROM mail_deliveries WHERE message_id IN (SELECT id FROM mail_messages WHERE kind = 'payment_succeeded')").run();
    await env.DB.prepare("DELETE FROM mail_messages WHERE kind = 'payment_succeeded'").run();

    await app.applyPaymentResult(event);
    await app.applyPaymentResult(event);

    expect(kindsOf(await mailOf(alice))).toEqual(["invoice_issued", "order_placed", "payment_succeeded"]);
  });
});

describe("待辦清單", () => {
  it("超過最新 200 封的舊信只要還沒送達就仍列出；已被取代的驗證信不算待辦", async () => {
    const alice = await signInCustomer("alice", "Alice", { verifiedContact: false });
    const customerId = (await app.getCustomerSession(alice)).customer!.customerId;
    // 舊請求的驗證信投遞失敗（未送達），之後被新請求取代；新請求的驗證信送達
    await app.setMailDeliveryFailure(await mintAccessJwt(), { enabled: true });
    await app.requestContactEmail(alice, { email: "old@example.com" });
    await app.setMailDeliveryFailure(await mintAccessJwt(), { enabled: false });
    await app.requestContactEmail(alice, { email: "new@example.com" });
    await env.DB.prepare("INSERT INTO mail_messages (customer_id, kind, subject, body, event_key, created_at) VALUES (?, 'order_placed', 's', 'b', 'order_placed:900', ?)").bind(customerId, NOW).run();
    const filler = Array.from({ length: 205 }, (_, index) =>
      env.DB.prepare("INSERT INTO mail_messages (customer_id, kind, subject, body, event_key, created_at) VALUES (?, 'order_placed', 's', 'b', ?, ?)").bind(customerId, `filler:${index}`, NOW));
    await env.DB.batch([...filler, env.DB.prepare("INSERT INTO mail_deliveries (message_id, recipient_address, status, attempted_at) SELECT id, 'a@example.com', 'delivered', 0 FROM mail_messages WHERE event_key LIKE 'filler:%'")]);

    const { messages } = await adminMail();
    const attention = messages.filter((message) => message.needsAttention);
    expect(messages.length).toBe(200 + attention.filter((message) => message.id < messages[199]!.id).length);
    expect(attention.map((message) => message.kind)).toEqual(["order_placed"]);
  });

  it("待辦最多再列 500 封，更舊的只回報筆數", async () => {
    const alice = await signInCustomer("alice");
    const customerId = (await app.getCustomerSession(alice)).customer!.customerId;
    await env.DB.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 703)
      INSERT INTO mail_messages (customer_id, kind, subject, body, event_key, created_at) SELECT ?, 'order_placed', 's', 'b', 'bulk:' || i, ? FROM n`).bind(customerId, NOW).run();

    const listed = await adminMail();

    // 703 封全是待辦：只列最新 500 封，其餘 203 封只回報筆數
    expect(listed.messages).toHaveLength(500);
    expect(listed.omittedAttention).toBe(203);
  });
});

describe("通知的權限", () => {
  it("顧客讀不到別人的交易通知，管理端的待辦不外洩內文", async () => {
    const alice = await signInCustomer("alice");
    const bob = await signInCustomer("bob");
    await placeMugOrder(alice);

    expect(await mailOf(bob)).toEqual([]);
    const [message] = await mailOf(alice);
    expect(await app.getMyMail(bob, { messageId: message!.id })).toEqual({ ok: false, reason: "mail_not_found" });
    expect(JSON.stringify(await adminMail())).not.toContain("NT$");
  });
});
