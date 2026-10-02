import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mintAccessJwt } from "./access";
import { setNow } from "./clock";
import { signInCustomer } from "./customers";
import { resetDb } from "./db";
import { installFakeGateway, type FakeGateway } from "./fake-gateway";
import { orderOf, placeMugOrder, startPaymentFor, stockOf } from "./payment-helpers";
import { app, PAYMENT_WINDOW_MS, placeOrderAt, runCron, stocked, stockOf as releaseStockOf } from "./release-helpers";
import { RECONCILE_BATCH_SIZE, RECONCILE_BUDGET_MS, RECONCILE_GRACE_MS } from "../src/payments/reconcile";

const T0 = Date.UTC(2026, 9, 3, 2, 0, 0);

beforeEach(async () => {
  await resetDb();
  setNow(T0);
});
afterEach(() => vi.restoreAllMocks());

/** 這張訂單上第一筆付款的本站編號。 */
async function firstPaymentId(cookie: string, orderId: number): Promise<number> {
  const [payment] = (await orderOf(cookie, orderId)).payments;
  if (!payment) throw new Error("訂單沒有付款");
  return payment.id;
}

/** 一位顧客下單並發起付款，回傳顧客、訂單、本站付款編號與閘道付款 ID（付款仍是 pending）。 */
async function pendingPayment(gateway: FakeGateway, onHand = 10) {
  const alice = await signInCustomer("alice");
  const placed = await placeMugOrder(alice, { onHand, quantity: 2 });
  const gatewayPaymentId = await startPaymentFor(alice, placed.orderId, gateway);
  return { alice, ...placed, gatewayPaymentId, paymentId: await firstPaymentId(alice, placed.orderId) };
}

async function reconcile(paymentId: number) {
  return app.reconcilePayment(await mintAccessJwt(), { paymentId });
}

async function listing() {
  const result = await app.listPaymentsToReconcile(await mintAccessJwt());
  if (!result.ok) throw new Error("讀取補查清單失敗");
  return result.data;
}

/** 待辦的 `resolved_at`（直接讀表，只為驗證它是待辦開著與否的唯一依據）。 */
async function resolvedAtOf(paymentId: number): Promise<number | null> {
  const row = await env.DB.prepare("SELECT resolved_at FROM payment_reconcile_issues WHERE payment_id = ?").bind(paymentId).first<{ resolved_at: number | null }>();
  if (!row) throw new Error("沒有待辦");
  return row.resolved_at;
}

async function mailKinds(cookie: string): Promise<string[]> {
  const list = await app.listMyMail(cookie);
  if (!list.ok) throw new Error("讀信失敗");
  return list.data.map((message) => message.kind).sort();
}

describe("管理員補查：不依賴顧客返回頁面", () => {
  it("閘道已收款、webhook 與導回都沒到：補查套用結果，訂單轉已付款保留（在庫數不動），付款結果通知同時寫入", async () => {
    const gateway = installFakeGateway();
    const { alice, orderId, variantId, gatewayPaymentId, paymentId } = await pendingPayment(gateway);
    gateway.settle(gatewayPaymentId, "succeeded");
    expect((await orderOf(alice, orderId)).status).toBe("pending_payment");
    expect((await listing()).payments).toMatchObject([{ paymentId, orderId, issue: null }]);

    const result = await reconcile(paymentId);

    expect(result).toEqual({ ok: true, data: { outcome: "settled", paymentStatus: "succeeded", orderStatus: "paid" } });
    expect((await orderOf(alice, orderId)).status).toBe("paid");
    expect(await stockOf(variantId)).toEqual({ onHand: 10, available: 8 });
    expect(await mailKinds(alice)).toContain("payment_succeeded");
    expect((await listing()).payments).toEqual([]);
  });

  it("重複補查、補查後 webhook 才到、先後順序改變：只入帳一次，通知只一封，不重複保留", async () => {
    const gateway = installFakeGateway();
    const { alice, orderId, variantId, gatewayPaymentId, paymentId } = await pendingPayment(gateway);
    const event = gateway.settle(gatewayPaymentId, "succeeded");

    await reconcile(paymentId);
    const again = await reconcile(paymentId);
    const webhook = await app.applyPaymentResult(event);

    expect(again).toEqual({ ok: false, reason: "payment_not_pending" });
    expect(webhook).toEqual({ ok: true, data: { paymentStatus: "succeeded", orderStatus: "paid" } });
    expect(await stockOf(variantId)).toEqual({ onHand: 10, available: 8 });
    expect((await mailKinds(alice)).filter((kind) => kind === "payment_succeeded")).toHaveLength(1);
    expect((await orderOf(alice, orderId)).payments).toMatchObject([{ status: "succeeded" }]);
    expect(gateway.refunded).toEqual([]);
  });

  it("閘道說付款失敗：付款記為失敗，訂單仍待付款", async () => {
    const gateway = installFakeGateway();
    const { alice, orderId, gatewayPaymentId, paymentId } = await pendingPayment(gateway);
    gateway.settle(gatewayPaymentId, "failed");

    expect(await reconcile(paymentId)).toEqual({ ok: true, data: { outcome: "settled", paymentStatus: "failed", orderStatus: "pending_payment" } });
    expect((await orderOf(alice, orderId)).payments).toMatchObject([{ status: "failed" }]);
  });

  it("閘道端已失效：本地付款轉 expired；閘道仍在等待：維持 pending、不留待辦", async () => {
    const gateway = installFakeGateway();
    const { gatewayPaymentId, paymentId } = await pendingPayment(gateway);

    expect(await reconcile(paymentId)).toEqual({ ok: true, data: { outcome: "waiting" } });
    expect((await listing()).payments).toMatchObject([{ paymentId, issue: null }]);

    gateway.payments.get(gatewayPaymentId)!.status = "expired";
    expect(await reconcile(paymentId)).toEqual({ ok: true, data: { outcome: "expired" } });
    expect((await listing()).payments).toEqual([]);
  });

  it("遲到付款：訂單已逾期、庫存還在，補查重新取得完整保留（在庫數不動），不退款", async () => {
    const gateway = installFakeGateway();
    const alice = await signInCustomer("alice");
    const variantId = await stocked(10);
    const order = await placeOrderAt(alice, variantId, 2, T0);
    setNow(T0 + 1_000);
    const gatewayPaymentId = await startPaymentFor(alice, order.orderId, gateway);
    const paymentId = await firstPaymentId(alice, order.orderId);
    await runCron(order.paymentDeadline);
    gateway.settle(gatewayPaymentId, "succeeded");
    expect((await orderOf(alice, order.orderId)).status).toBe("expired");

    const result = await reconcile(paymentId);

    expect(result).toEqual({ ok: true, data: { outcome: "settled", paymentStatus: "succeeded", orderStatus: "paid" } });
    expect(await releaseStockOf(variantId)).toEqual({ onHand: 10, available: 8 });
    expect(gateway.refunded).toEqual([]);
  });

  it("遲到付款重新保留不到：沿用原規則退款（late_success_unreclaimable），補查結果是已退款", async () => {
    const gateway = installFakeGateway();
    const alice = await signInCustomer("alice");
    const variantId = await stocked(2);
    const order = await placeOrderAt(alice, variantId, 2, T0);
    setNow(T0 + 1_000);
    const gatewayPaymentId = await startPaymentFor(alice, order.orderId, gateway);
    const paymentId = await firstPaymentId(alice, order.orderId);
    await runCron(order.paymentDeadline);
    gateway.settle(gatewayPaymentId, "succeeded");
    const bob = await signInCustomer("bob");
    await placeOrderAt(bob, variantId, 2, order.paymentDeadline + 1_000);

    const result = await reconcile(paymentId);

    expect(result).toEqual({ ok: true, data: { outcome: "settled", paymentStatus: "succeeded", orderStatus: "expired" } });
    expect(gateway.refunded).toEqual([gatewayPaymentId]);
    expect((await orderOf(alice, order.orderId)).refunds).toMatchObject([{ status: "succeeded", reason: "late_success_unreclaimable" }]);
  });
});

describe("補查沒能確認結果：不偽造成功，留下可追溯的待辦", () => {
  it("閘道連不上：訂單不動、記待辦（原因、次數、觸發者）；再失敗累計次數；補查成功後待辦消失", async () => {
    const gateway = installFakeGateway();
    const { alice, orderId, gatewayPaymentId, paymentId } = await pendingPayment(gateway);
    gateway.settle(gatewayPaymentId, "succeeded");
    const errors = vi.spyOn(console, "error");

    gateway.failNext("get", 0);
    expect(await reconcile(paymentId)).toEqual({ ok: true, data: { outcome: "issue", reason: "gateway_unavailable" } });
    gateway.failNext("get", 502);
    await reconcile(paymentId);

    expect((await orderOf(alice, orderId)).status).toBe("pending_payment");
    const open = await listing();
    expect(open.payments).toMatchObject([
      { paymentId, orderId, issue: { reason: "gateway_unavailable", attempts: 2, lastSource: "admin@example.com" } },
    ]);
    expect(open.payments[0]!.issue!.lastAt).toBeGreaterThanOrEqual(open.payments[0]!.issue!.firstAt);
    expect(errors.mock.calls.some(([line]) => String(line).includes('"event":"payment_reconcile_issue"'))).toBe(true);

    expect(await reconcile(paymentId)).toMatchObject({ ok: true, data: { outcome: "settled" } });
    expect((await listing()).payments).toEqual([]);
  });

  it.each([
    ["付款 ID 不符", { id: "pay_other" }],
    ["金額不符", { amountTwd: 1 }],
    ["商家參照不是這張訂單", { merchantReference: "999999" }],
  ])("閘道回的%s：不套用，待辦原因是 gateway_mismatch", async (_label, tampered) => {
    const gateway = installFakeGateway();
    const { alice, orderId, gatewayPaymentId, paymentId } = await pendingPayment(gateway);
    gateway.settle(gatewayPaymentId, "succeeded");
    Object.assign(gateway.payments.get(gatewayPaymentId)!, tampered);

    expect(await reconcile(paymentId)).toEqual({ ok: true, data: { outcome: "issue", reason: "gateway_mismatch" } });

    expect((await orderOf(alice, orderId)).status).toBe("pending_payment");
    expect((await listing()).payments).toMatchObject([{ issue: { reason: "gateway_mismatch", attempts: 1 } }]);
  });

  it("閘道說成功卻沒有事件 ID：結果不明，不套用，待辦原因是 result_unclear", async () => {
    const gateway = installFakeGateway();
    const { alice, orderId, gatewayPaymentId, paymentId } = await pendingPayment(gateway);
    gateway.settle(gatewayPaymentId, "succeeded");
    gateway.payments.get(gatewayPaymentId)!.eventId = null;

    expect(await reconcile(paymentId)).toEqual({ ok: true, data: { outcome: "issue", reason: "result_unclear" } });
    expect((await orderOf(alice, orderId)).status).toBe("pending_payment");
  });

  it("待辦開著時付款被 webhook 套用：待辦不再列出（由付款狀態推導）", async () => {
    const gateway = installFakeGateway();
    const { gatewayPaymentId, paymentId } = await pendingPayment(gateway);
    const event = gateway.settle(gatewayPaymentId, "succeeded");
    gateway.failNext("get", 502);
    await reconcile(paymentId);
    expect((await listing()).payments).toHaveLength(1);

    await app.applyPaymentResult(event);

    expect((await listing()).payments).toEqual([]);
    expect(await resolvedAtOf(paymentId)).not.toBeNull();
  });

  it("付款被顧客取消訂單轉為 expired：開著的待辦同步記為已解決", async () => {
    const gateway = installFakeGateway();
    const { alice, orderId, paymentId } = await pendingPayment(gateway);
    gateway.failNext("get", 502);
    await reconcile(paymentId);
    expect(await resolvedAtOf(paymentId)).toBeNull();

    expect(await app.cancelOrder(alice, { orderId })).toMatchObject({ ok: true });

    expect(await resolvedAtOf(paymentId)).not.toBeNull();
    expect((await listing()).payments).toEqual([]);
  });

  it("待辦解決後同一筆付款再出問題：重新計次，不沿用舊的次數", async () => {
    const gateway = installFakeGateway();
    const { paymentId } = await pendingPayment(gateway);
    gateway.failNext("get", 502);
    await reconcile(paymentId);
    gateway.failNext("get", 502);
    await reconcile(paymentId);
    await reconcile(paymentId); // pending：解決
    gateway.failNext("get", 502);
    await reconcile(paymentId);

    expect((await listing()).payments).toMatchObject([{ issue: { attempts: 1 } }]);
  });

  it("待辦排在清單最前面，其餘依建立順序", async () => {
    const gateway = installFakeGateway();
    const first = await pendingPayment(gateway);
    const bob = await signInCustomer("bob");
    const second = await placeMugOrder(bob);
    await startPaymentFor(bob, second.orderId, gateway);
    const secondPaymentId = await firstPaymentId(bob, second.orderId);
    gateway.failNext("get", 502);
    await reconcile(secondPaymentId);

    const { payments } = await listing();

    expect(payments.map((payment) => payment.paymentId)).toEqual([secondPaymentId, first.paymentId]);
  });
});

describe("補查的權限與輸入", () => {
  it("沒有有效 Access JWT：兩個 RPC 都 unauthorized，不查閘道", async () => {
    const gateway = installFakeGateway();
    const { paymentId, gatewayPaymentId } = await pendingPayment(gateway);
    gateway.settle(gatewayPaymentId, "succeeded");

    expect(await app.reconcilePayment("not-a-jwt", { paymentId })).toEqual({ ok: false, reason: "unauthorized" });
    expect(await app.listPaymentsToReconcile("not-a-jwt")).toEqual({ ok: false, reason: "unauthorized" });
    expect((await listing()).payments).toHaveLength(1);
  });

  it("顧客 cookie 不是管理員身分：unauthorized", async () => {
    const alice = await signInCustomer("alice");
    expect(await app.listPaymentsToReconcile(alice)).toEqual({ ok: false, reason: "unauthorized" });
  });

  it("付款編號無效、不存在、已有結果，各回對應原因", async () => {
    const gateway = installFakeGateway();
    const { gatewayPaymentId, paymentId } = await pendingPayment(gateway);
    gateway.settle(gatewayPaymentId, "failed");
    await reconcile(paymentId);

    expect(await reconcile(0)).toMatchObject({ ok: false, reason: "invalid_input" });
    expect(await reconcile(999_999)).toEqual({ ok: false, reason: "payment_not_found" });
    expect(await reconcile(paymentId)).toEqual({ ok: false, reason: "payment_not_pending" });
  });
});

describe("Cron 補查", () => {
  it("只補查建立超過寬限時間的 pending 付款：閘道已收款的訂單在逾期處理之前轉為已付款", async () => {
    const gateway = installFakeGateway();
    const alice = await signInCustomer("alice");
    const variantId = await stocked(10);
    const order = await placeOrderAt(alice, variantId, 2, T0);
    setNow(T0 + 1_000);
    const gatewayPaymentId = await startPaymentFor(alice, order.orderId, gateway);
    gateway.settle(gatewayPaymentId, "succeeded");

    await runCron(T0 + 1_000 + RECONCILE_GRACE_MS - 1);
    expect((await orderOf(alice, order.orderId)).status).toBe("pending_payment");

    await runCron(T0 + 1_000 + RECONCILE_GRACE_MS + 1_000);
    expect((await orderOf(alice, order.orderId)).status).toBe("paid");
    expect(await releaseStockOf(variantId)).toEqual({ onHand: 10, available: 8 });
  });

  it("付款期限已過、同一次 Cron：先補查再逾期，期限前就收款的訂單不會被轉成逾期", async () => {
    const gateway = installFakeGateway();
    const alice = await signInCustomer("alice");
    const variantId = await stocked(10);
    const order = await placeOrderAt(alice, variantId, 2, T0);
    setNow(T0 + 1_000);
    const gatewayPaymentId = await startPaymentFor(alice, order.orderId, gateway);
    gateway.settle(gatewayPaymentId, "succeeded");

    await runCron(order.paymentDeadline + 1_000);

    expect((await orderOf(alice, order.orderId)).status).toBe("paid");
    expect(gateway.refunded).toEqual([]);
  });

  it("閘道連不上：記待辦，其餘 Cron 工作（訂單逾期）照常進行；下次閘道恢復自動補上", async () => {
    const gateway = installFakeGateway();
    const alice = await signInCustomer("alice");
    const variantId = await stocked(10);
    const order = await placeOrderAt(alice, variantId, 2, T0);
    setNow(T0 + 1_000);
    const gatewayPaymentId = await startPaymentFor(alice, order.orderId, gateway);
    gateway.settle(gatewayPaymentId, "succeeded");
    gateway.failNext("get", 0);

    await runCron(order.paymentDeadline + 1_000);

    expect((await orderOf(alice, order.orderId)).status).toBe("expired");
    expect((await listing()).payments).toMatchObject([{ issue: { reason: "gateway_unavailable", attempts: 1, lastSource: "cron" } }]);

    await runCron(order.paymentDeadline + 61_000);
    // 逾期的訂單遇到遲到的成功：重新保留
    expect((await orderOf(alice, order.orderId)).status).toBe("paid");
    expect((await listing()).payments).toEqual([]);
  });

  it("每次最多補查一個批次：前 20 筆閘道都說仍在等待，第 21 筆已收款，第二次 Cron 輪到它轉為已付款", async () => {
    const gateway = installFakeGateway();
    const alice = await signInCustomer("alice");
    const variantId = await stocked(100);
    const placed = [] as { orderId: number; gatewayPaymentId: string }[];
    for (let i = 0; i < RECONCILE_BATCH_SIZE + 1; i++) {
      const order = await placeOrderAt(alice, variantId, 1, T0 + i);
      placed.push({ orderId: order.orderId, gatewayPaymentId: await startPaymentFor(alice, order.orderId, gateway) });
    }
    const last = placed[RECONCILE_BATCH_SIZE]!;
    gateway.settle(last.gatewayPaymentId, "succeeded");
    const at = T0 + RECONCILE_BATCH_SIZE + RECONCILE_GRACE_MS + 1_000;
    expect(at).toBeLessThan(T0 + PAYMENT_WINDOW_MS);

    await runCron(at);
    expect((await orderOf(alice, last.orderId)).status).toBe("pending_payment");
    await runCron(at + 1_000);

    expect((await orderOf(alice, last.orderId)).status).toBe("paid");
  }, 30_000);

  it("一直查不出結果（閘道出錯）的付款也輪替，不會把其他付款擠出名額", async () => {
    const gateway = installFakeGateway();
    const alice = await signInCustomer("alice");
    const variantId = await stocked(100);
    const placed = [] as { orderId: number; gatewayPaymentId: string }[];
    for (let i = 0; i < RECONCILE_BATCH_SIZE + 1; i++) {
      const order = await placeOrderAt(alice, variantId, 1, T0 + i);
      placed.push({ orderId: order.orderId, gatewayPaymentId: await startPaymentFor(alice, order.orderId, gateway) });
    }
    const last = placed[RECONCILE_BATCH_SIZE]!;
    gateway.settle(last.gatewayPaymentId, "succeeded");
    const original = gateway.handle.bind(gateway);
    vi.spyOn(gateway, "handle").mockImplementation((request) =>
      request.url.endsWith(`/v1/payments/${placed[0]!.gatewayPaymentId}`) ? Promise.resolve(Response.json({ ok: false, error: { code: "x", message: "x" } }, { status: 502 })) : original(request),
    );
    const at = T0 + RECONCILE_BATCH_SIZE + RECONCILE_GRACE_MS + 1_000;

    await runCron(at);
    await runCron(at + 1_000);

    expect((await orderOf(alice, last.orderId)).status).toBe("paid");
  }, 30_000);

  it("付款期限前 2 分鐘內才發起（建立不滿寬限時間）、閘道已收款卻漏通知：過了失效時間就補查，訂單逾期之前入帳", async () => {
    const gateway = installFakeGateway();
    const alice = await signInCustomer("alice");
    const variantId = await stocked(10);
    const order = await placeOrderAt(alice, variantId, 2, T0);
    setNow(T0 + 10 * 60_000);
    const gatewayPaymentId = await startPaymentFor(alice, order.orderId, gateway);
    gateway.settle(gatewayPaymentId, "succeeded");
    // 失效時間是付款期限前 2 分鐘（T0 + 13 分）；此時建立才 2 分鐘，還沒到寬限時間
    await runCron(T0 + 12 * 60_000);
    expect((await orderOf(alice, order.orderId)).status).toBe("pending_payment");

    await runCron(T0 + 13 * 60_000 + 1_000);

    expect((await orderOf(alice, order.orderId)).status).toBe("paid");
    expect(gateway.refunded).toEqual([]);
  });

  it("閘道卡住（永不回應）：呼叫逾時記為待辦，同一次 Cron 的訂單逾期照常生效", async () => {
    const gateway = installFakeGateway();
    const alice = await signInCustomer("alice");
    const variantId = await stocked(10);
    const order = await placeOrderAt(alice, variantId, 2, T0);
    setNow(T0 + 1_000);
    const gatewayPaymentId = await startPaymentFor(alice, order.orderId, gateway);
    gateway.settle(gatewayPaymentId, "succeeded");
    vi.spyOn(gateway, "handle").mockImplementation(() => new Promise<Response>(() => undefined));

    await runCron(order.paymentDeadline + 1_000);

    expect((await orderOf(alice, order.orderId)).status).toBe("expired");
    expect((await listing()).payments).toMatchObject([{ issue: { reason: "gateway_unavailable", lastSource: "cron" } }]);
  }, 30_000);

  it("補查超過時間預算：不再開始新的一筆，其餘 Cron 工作照常進行，沒查到的下次輪替", async () => {
    const gateway = installFakeGateway();
    const alice = await signInCustomer("alice");
    const variantId = await stocked(10);
    const placed = [] as { orderId: number; gatewayPaymentId: string }[];
    for (let i = 0; i < 3; i++) {
      const order = await placeOrderAt(alice, variantId, 1, T0 + i);
      placed.push({ orderId: order.orderId, gatewayPaymentId: await startPaymentFor(alice, order.orderId, gateway) });
    }
    for (const { gatewayPaymentId } of placed) gateway.settle(gatewayPaymentId, "succeeded");
    const original = gateway.handle.bind(gateway);
    let lookups = 0;
    vi.spyOn(gateway, "handle").mockImplementation((request) => {
      lookups += 1;
      vi.setSystemTime(Date.now() + RECONCILE_BUDGET_MS + 1_000);
      return original(request);
    });
    const at = T0 + RECONCILE_GRACE_MS + 1_000;

    await runCron(at);

    expect(lookups).toBe(1);
    const statuses = await Promise.all(placed.map(async ({ orderId }) => (await orderOf(alice, orderId)).status));
    expect(statuses.filter((status) => status === "paid")).toHaveLength(1);
  });
});
