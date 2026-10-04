import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { commitRefund, registerPaymentRefund } from "../src/payments/refunds";
import { ADMIN_EMAIL, mintAccessJwt } from "./access";
import { DEFAULT_SHIPPING_TWD } from "./checkout-helpers";
import { signInCustomer } from "./customers";
import { forceOrderStatus, resetDb, seedPayment } from "./db";
import { installFakeGateway } from "./fake-gateway";
import { noInvoices, orderOf, placeMugOrder, startPaymentFor } from "./payment-helpers";
import { app } from "./release-helpers";

const db = drizzle(env.DB);

afterEach(() => vi.restoreAllMocks());

/**
 * 已取消的訂單上有兩筆「成功」的付款（取消與付款的競態）：兩筆都要整筆退款，
 * 第一筆是 `startPayment` 發起的，第二筆直接安排（正常流程做不到兩筆同時進行）。回傳兩筆付款的閘道 ID 與各自的成功事件。
 */
async function twoLatePayments() {
  const alice = await signInCustomer("alice");
  const { orderId, totalTwd } = await placeMugOrder(alice, { onHand: 10, quantity: 2 });
  const gateway = installFakeGateway();
  const first = await startPaymentFor(alice, orderId, gateway);
  const second = await seedPayment(orderId, "pending", "pay_second", totalTwd);
  gateway.adopt(second, { amountTwd: totalTwd, merchantReference: String(orderId) });
  await forceOrderStatus(orderId, "cancelled");
  return { alice, orderId, totalTwd, gateway, first, second, settleFirst: () => gateway.settle(first, "succeeded"), settleSecond: () => gateway.settle(second, "succeeded") };
}

const adminRefunds = async (orderId: number) => {
  const found = await app.getOrderForAdmin(await mintAccessJwt(), { orderId });
  if (!found.ok) throw new Error("讀取訂單失敗");
  return found.data.refunds;
};

const todos = async () => {
  const listed = await app.listRefundsToHandle(await mintAccessJwt());
  if (!listed.ok) throw new Error("讀取退款待辦失敗");
  return listed.data;
};

/** 退款紀錄的閘道退款 ID（冪等鍵，登記時產生、永不更改）。 */
const gatewayRefundIdOf = async (refundId: number) => (await env.DB.prepare("SELECT gateway_refund_id AS g FROM refunds WHERE id = ?").bind(refundId).first<{ g: string }>())!.g;

const retry = async (refundId: number) => app.retryRefund(await mintAccessJwt(), { refundId });

beforeEach(resetDb);

describe("逐筆退款：金額、拆分與綁定的收款", () => {
  it("遲到付款的整筆退款：金額等於那筆付款的實收，拆成商品款與原運費，綁定該筆付款；顧客也看得到這筆退款", async () => {
    const { alice, orderId, totalTwd, gateway, settleFirst, first } = await twoLatePayments();

    await app.applyPaymentResult(settleFirst());

    const [refund] = await adminRefunds(orderId);
    expect(refund).toMatchObject({
      reason: "cancelled_order",
      status: "succeeded",
      amountTwd: totalTwd,
      goodsTwd: totalTwd - DEFAULT_SHIPPING_TWD,
      shippingTwd: DEFAULT_SHIPPING_TWD,
      settledAt: expect.any(Number),
      attempts: [{ actor: "system", action: "send", outcome: "succeeded", code: null }],
    });
    const order = await orderOf(alice, orderId);
    expect(order.payments[0]!.id).toBe(refund!.paymentId);
    expect(order.refunds).toEqual([{ id: refund!.id, paymentId: refund!.paymentId, reason: "cancelled_order", amountTwd: totalTwd, goodsTwd: totalTwd - DEFAULT_SHIPPING_TWD, shippingTwd: DEFAULT_SHIPPING_TWD, status: "succeeded", createdAt: expect.any(Number), settledAt: expect.any(Number) }]);
    expect(gateway.refundRequests).toEqual([{ paymentId: first, refundId: await gatewayRefundIdOf(refund!.id), amountTwd: totalTwd }]);
  });

  it("兩筆付款各退各自的實收，不跨收款：每筆退款對應自己的閘道付款", async () => {
    const { orderId, totalTwd, gateway, first, second, settleFirst, settleSecond } = await twoLatePayments();

    await app.applyPaymentResult(settleFirst());
    await app.applyPaymentResult(settleSecond());

    expect(gateway.refundRequests.map(({ paymentId, amountTwd }) => ({ paymentId, amountTwd }))).toEqual([
      { paymentId: first, amountTwd: totalTwd },
      { paymentId: second, amountTwd: totalTwd },
    ]);
    expect((await adminRefunds(orderId)).map((refund) => refund.status)).toEqual(["succeeded", "succeeded"]);
    expect(gateway.refundedTwd(first)).toBe(totalTwd);
    expect(gateway.refundedTwd(second)).toBe(totalTwd);
  });

  it("成功退款通知：寄一封退款通知，重試與重複事件都不重複", async () => {
    const { alice, settleFirst, gateway } = await twoLatePayments();
    gateway.failNextRefundExplicitly();
    const event = settleFirst();
    await app.applyPaymentResult(event);
    const [todo] = (await todos()).refunds;

    await retry(todo!.id);
    await retry(todo!.id);
    await app.applyPaymentResult(event);

    const mail = await app.listMyMail(alice);
    expect(mail.ok && mail.data.filter((message) => message.kind === "refund_succeeded")).toHaveLength(1);
  });
});

describe("明確失敗：保留額度與待辦，後筆可前進，重試沿用同一筆", () => {
  it("失敗那筆列在待辦、付款不能再登記別筆退款；同單另一筆付款的退款照常前進", async () => {
    const { orderId, gateway, first, settleFirst, settleSecond } = await twoLatePayments();
    gateway.failNextRefundExplicitly();

    await app.applyPaymentResult(settleFirst());
    await app.applyPaymentResult(settleSecond());

    const refunds = await adminRefunds(orderId);
    expect(refunds.map((refund) => refund.status)).toEqual(["failed", "succeeded"]);
    expect((await todos()).refunds).toMatchObject([{ id: refunds[0]!.id, status: "failed", blocked: false, attempts: [{ outcome: "failed", code: "refund_failed" }] }]);
    // 失敗那筆仍佔用整筆額度：這筆付款不能再登記另一筆退款
    const firstPaymentId = refunds[0]!.paymentId;
    expect(await commitRefund(env.DB, { paymentId: firstPaymentId, reason: "duplicate_success", amountTwd: 1, goodsTwd: 1, shippingTwd: 0 }, Date.now())).toBeNull();
    expect(await registerPaymentRefund(env.DB, firstPaymentId, "duplicate_success", Date.now())).toBeNull();
    expect(await registerPaymentRefund(env.DB, firstPaymentId, "cancelled_order", Date.now())).toBe(refunds[0]!.id);
    expect(await adminRefunds(orderId)).toHaveLength(2);
    expect(gateway.refundedTwd(first)).toBe(0);
  });

  it("管理員重試：沿用同一筆退款與同一個閘道退款 ID，成功後額度與待辦結案，操作者留在嘗試紀錄", async () => {
    const { orderId, totalTwd, gateway, first, settleFirst } = await twoLatePayments();
    gateway.failNextRefundExplicitly();
    await app.applyPaymentResult(settleFirst());
    const [failed] = await adminRefunds(orderId);

    const result = await retry(failed!.id);

    expect(result).toEqual({ ok: true, data: { status: "succeeded" } });
    const [refund, ...rest] = await adminRefunds(orderId);
    expect(rest).toEqual([]);
    expect(refund).toMatchObject({ id: failed!.id, status: "succeeded" });
    expect(refund!.attempts.map(({ actor, action, outcome }) => ({ actor, action, outcome }))).toEqual([
      { actor: "system", action: "send", outcome: "failed" },
      { actor: ADMIN_EMAIL, action: "send", outcome: "succeeded" },
    ]);
    const gatewayId = await gatewayRefundIdOf(failed!.id);
    expect(gatewayId).toMatch(/^rf_[0-9a-f-]{36}$/);
    expect(gateway.refundRequests.map(({ refundId }) => refundId)).toEqual([gatewayId, gatewayId]);
    expect(gateway.refundedTwd(first)).toBe(totalTwd);
    expect((await todos()).refunds).toEqual([]);
  });

  it("已成功的退款再重試是冪等的：回成功、不再打閘道", async () => {
    const { orderId, gateway, settleFirst } = await twoLatePayments();
    await app.applyPaymentResult(settleFirst());
    const [refund] = await adminRefunds(orderId);

    expect(await retry(refund!.id)).toEqual({ ok: true, data: { status: "succeeded" } });

    expect(gateway.refundRequests).toHaveLength(1);
  });
});

describe("結果不明：先查再決定，阻擋同單後筆", () => {
  it("回應遺失但閘道其實已退回：重試先查證，確認成功就結案，不重送", async () => {
    const { orderId, totalTwd, gateway, first, settleFirst } = await twoLatePayments();
    gateway.loseNextRefundResponse();
    await app.applyPaymentResult(settleFirst());
    const [unknown] = await adminRefunds(orderId);
    expect(unknown).toMatchObject({ status: "unknown", attempts: [{ action: "send", outcome: "unknown", code: "unreachable" }] });

    const result = await retry(unknown!.id);

    expect(result).toEqual({ ok: true, data: { status: "succeeded" } });
    expect(gateway.refundRequests).toHaveLength(1);
    expect(gateway.refundedTwd(first)).toBe(totalTwd);
    expect((await adminRefunds(orderId))[0]!.attempts.map(({ actor, action, outcome }) => ({ actor, action, outcome }))).toEqual([
      { actor: "system", action: "send", outcome: "unknown" },
      { actor: ADMIN_EMAIL, action: "verify", outcome: "succeeded" },
    ]);
  });

  it("請求其實沒送到閘道：查證得知從未收過，才用同一個退款 ID 送出", async () => {
    const { orderId, gateway, settleFirst } = await twoLatePayments();
    gateway.failNext("refund", 503);
    await app.applyPaymentResult(settleFirst());
    const [unknown] = await adminRefunds(orderId);
    expect(unknown!.status).toBe("unknown");

    await retry(unknown!.id);

    const [refund] = await adminRefunds(orderId);
    expect(refund).toMatchObject({ status: "succeeded" });
    expect(refund!.attempts.map(({ action, outcome }) => `${action}:${outcome}`)).toEqual(["send:unknown", "verify:not_found", "send:succeeded"]);
    expect(gateway.refundRequests.map(({ refundId }) => refundId)).toEqual([await gatewayRefundIdOf(unknown!.id)]);
  });

  it("查證本身也失敗：仍是結果不明，沒有送出新的退款", async () => {
    const { orderId, gateway, settleFirst } = await twoLatePayments();
    gateway.loseNextRefundResponse();
    await app.applyPaymentResult(settleFirst());
    const [unknown] = await adminRefunds(orderId);
    gateway.failNext("getRefund", 0);

    expect(await retry(unknown!.id)).toEqual({ ok: true, data: { status: "unknown" } });

    expect(gateway.refundRequests).toHaveLength(1);
    expect((await adminRefunds(orderId))[0]!.attempts.at(-1)).toMatchObject({ action: "verify", outcome: "unknown", code: "unreachable" });
  });

  it("不明的退款阻擋同單後筆：後筆留在 pending 並被拒絕執行（refund_blocked），前筆查證後才能前進", async () => {
    const { orderId, gateway, settleFirst, settleSecond } = await twoLatePayments();
    gateway.loseNextRefundResponse();
    await app.applyPaymentResult(settleFirst());

    await app.applyPaymentResult(settleSecond());

    const [first, second] = await adminRefunds(orderId);
    expect([first!.status, second!.status]).toEqual(["unknown", "pending"]);
    expect(gateway.refundRequests).toHaveLength(1);
    expect((await todos()).refunds.map(({ id, blocked }) => ({ id, blocked }))).toEqual([{ id: first!.id, blocked: false }, { id: second!.id, blocked: true }]);
    expect(await retry(second!.id)).toEqual({ ok: false, reason: "refund_blocked" });

    await retry(first!.id);
    expect(await retry(second!.id)).toEqual({ ok: true, data: { status: "succeeded" } });
    expect((await adminRefunds(orderId)).map((refund) => refund.status)).toEqual(["succeeded", "succeeded"]);
    expect((await todos()).refunds).toEqual([]);
  });

  it("程序中斷卡在 processing：租約內視為進行中（擋住後筆、拒絕重複執行），租約過期後先查證再接手", async () => {
    const { orderId, gateway, first, settleFirst, settleSecond } = await twoLatePayments();
    gateway.loseNextRefundResponse();
    await app.applyPaymentResult(settleFirst());
    const [stuck] = await adminRefunds(orderId);
    await env.DB.prepare("UPDATE refunds SET status = 'processing', claimed_at = ? WHERE id = ?").bind(Date.now(), stuck!.id).run();

    expect(await retry(stuck!.id)).toEqual({ ok: false, reason: "refund_in_progress" });

    // 租約過期只讓卡住的那一筆能被接手查證；同單後筆仍然被擋，直到它查證結案
    await app.applyPaymentResult(settleSecond());
    const second = (await adminRefunds(orderId))[1]!;
    await env.DB.prepare("UPDATE refunds SET claimed_at = 0 WHERE id = ?").bind(stuck!.id).run();
    expect(await retry(second.id)).toEqual({ ok: false, reason: "refund_blocked" });
    expect(await retry(stuck!.id)).toEqual({ ok: true, data: { status: "succeeded" } });
    expect(await retry(second.id)).toEqual({ ok: true, data: { status: "succeeded" } });
    expect(gateway.refundedTwd(first)).toBeGreaterThan(0);
    expect(gateway.refundRequests).toHaveLength(2);
  });

  it("0024 搬來的舊退款（unknown、legacy_ 開頭的閘道退款 ID）：閘道其實已退款時，重試查證後成功，不送新退款", async () => {
    const { orderId, totalTwd, gateway, first, settleFirst } = await twoLatePayments();
    gateway.failNext("refund", 503);
    await app.applyPaymentResult(settleFirst());
    const [legacy] = await adminRefunds(orderId);
    await env.DB.prepare("UPDATE refunds SET gateway_refund_id = ? WHERE id = ?").bind(`legacy_${first}`, legacy!.id).run();
    gateway.refunds.set(`${first}/legacy_${first}`, { refundId: `legacy_${first}`, paymentId: first, amountTwd: totalTwd, status: "succeeded" });
    const requestsBefore = gateway.refundRequests.length;

    expect(await retry(legacy!.id)).toEqual({ ok: true, data: { status: "succeeded" } });

    expect(gateway.refundRequests).toHaveLength(requestsBefore);
    expect((await adminRefunds(orderId))[0]!.attempts.at(-1)).toMatchObject({ action: "verify", outcome: "succeeded" });
  });

  it("舊退款閘道從未收過：查證後才用同一個 legacy_ 退款 ID 送出", async () => {
    const { orderId, gateway, first, settleFirst } = await twoLatePayments();
    gateway.failNext("refund", 503);
    await app.applyPaymentResult(settleFirst());
    const [legacy] = await adminRefunds(orderId);
    await env.DB.prepare("UPDATE refunds SET gateway_refund_id = ? WHERE id = ?").bind(`legacy_${first}`, legacy!.id).run();

    expect(await retry(legacy!.id)).toEqual({ ok: true, data: { status: "succeeded" } });

    expect(gateway.refundRequests.map(({ refundId }) => refundId)).toEqual([`legacy_${first}`]);
  });
});

describe("同單互斥與重複回呼", () => {
  it("同一筆退款同時被兩個管理員重試：閘道只收到一次成功的退款", async () => {
    const { orderId, gateway, first, totalTwd, settleFirst } = await twoLatePayments();
    gateway.failNextRefundExplicitly();
    await app.applyPaymentResult(settleFirst());
    const [failed] = await adminRefunds(orderId);

    const results = await Promise.all([retry(failed!.id), retry(failed!.id)]);

    expect(results.some((result) => result.ok)).toBe(true);
    expect(gateway.refundedTwd(first)).toBe(totalTwd);
    expect((await adminRefunds(orderId))[0]!.status).toBe("succeeded");
  });

  it("付款成功事件重複送達（含同時）：只登記並退款一次", async () => {
    const { orderId, gateway, settleFirst } = await twoLatePayments();
    const event = settleFirst();

    await Promise.all([1, 2, 3].map(() => app.applyPaymentResult(event)));
    await app.applyPaymentResult(event);

    expect(await adminRefunds(orderId)).toHaveLength(1);
    expect(gateway.refundRequests).toHaveLength(1);
  });

  it("付款已套用成功、退款登記前程序中斷：同一事件重送時補登記並退款一次；讓訂單成立的那筆付款不會被誤退", async () => {
    const alice = await signInCustomer("alice");
    const { orderId, totalTwd } = await placeMugOrder(alice, { onHand: 10, quantity: 2 });
    const gateway = installFakeGateway();
    const paying = await startPaymentFor(alice, orderId, gateway);
    await app.applyPaymentResult(gateway.settle(paying, "succeeded"));
    // 另一筆成功的付款已寫入，但退款還沒登記（模擬中斷）
    const stray = await seedPayment(orderId, "succeeded", "pay_stray", totalTwd);
    gateway.adopt(stray, { amountTwd: totalTwd, merchantReference: String(orderId) });
    const strayEvent = gateway.settle(stray, "succeeded");
    expect((await app.listOrdersForAdmin(await mintAccessJwt(), {})).ok).toBe(true);

    await app.applyPaymentResult(strayEvent);
    await app.applyPaymentResult(strayEvent);
    await app.applyPaymentResult({ eventId: "evt_again", gatewayPaymentId: paying, outcome: "succeeded" });

    const refunds = await adminRefunds(orderId);
    expect(refunds).toMatchObject([{ reason: "duplicate_success", status: "succeeded", amountTwd: totalTwd }]);
    expect(gateway.refundRequests.map(({ paymentId }) => paymentId)).toEqual([stray]);
  });
});

describe("權限與可見範圍", () => {
  it("退款待辦與重試只有管理員能用", async () => {
    expect(await app.listRefundsToHandle("not-a-jwt")).toEqual({ ok: false, reason: "unauthorized" });
    expect(await app.retryRefund("not-a-jwt", { refundId: 1 })).toEqual({ ok: false, reason: "unauthorized" });
    expect(await app.retryRefund(await mintAccessJwt(), { refundId: "x" })).toMatchObject({ ok: false, reason: "invalid_input" });
    expect(await retry(999_999)).toEqual({ ok: false, reason: "refund_not_found" });
  });

  it("顧客只看得到自己訂單的退款，且看不到內部嘗試紀錄與操作者", async () => {
    const { alice, orderId, settleFirst } = await twoLatePayments();
    await app.applyPaymentResult(settleFirst());
    const bob = await signInCustomer("bob");

    expect(await app.getMyOrder(bob, { orderId })).toEqual({ ok: false, reason: "order_not_found" });
    const listed = await app.listMyOrders(bob);
    expect(listed.ok && listed.data).toEqual([]);
    const mine = await app.getMyOrder(alice, { orderId });
    expect(mine.ok && Object.keys(mine.data.refunds[0]!)).not.toContain("attempts");
  });

  it("沒有閘道設定時重試退款回 payment_unavailable，退款不動", async () => {
    const { orderId, settleFirst, gateway } = await twoLatePayments();
    gateway.failNextRefundExplicitly();
    await app.applyPaymentResult(settleFirst());
    const [failed] = await adminRefunds(orderId);
    const { createPaymentService } = await import("../src/payments/service");

    const service = createPaymentService(env.DB, { now: () => Date.now() }, async () => null, null, "http://localhost:4321", noInvoices);

    expect(await service.retryRefund(failed!.id, ADMIN_EMAIL)).toEqual({ ok: false, reason: "payment_unavailable" });
    expect((await adminRefunds(orderId))[0]!.status).toBe("failed");
  });
});

describe("承諾退款額度（#116、#121、#122 共用的單句條件寫入）", () => {
  it("並行承諾不超過實收：三筆各 300 對上 740 的付款，只有兩筆寫入", async () => {
    const { first, settleFirst } = await twoLatePayments();
    // 讓這筆付款成為訂單的支付者（不登記整筆退款），再直接承諾部分退款
    await env.DB.prepare("UPDATE orders SET status = 'paid'").run();
    await app.applyPaymentResult(settleFirst());
    const payment = (await env.DB.prepare("SELECT id, amount_twd FROM payments WHERE gateway_payment_id = ?").bind(first).first<{ id: number; amount_twd: number }>())!;
    await env.DB.batch([env.DB.prepare("DELETE FROM allowance_attempts"), env.DB.prepare("DELETE FROM allowance_obligations")]);
    await env.DB.prepare("DELETE FROM refund_attempts").run();
    await env.DB.prepare("DELETE FROM refunds").run();
    const commit = (reason: "late_success_unreclaimable" | "cancelled_order" | "duplicate_success", amountTwd: number) =>
      commitRefund(env.DB, { paymentId: payment.id, reason, amountTwd, goodsTwd: amountTwd, shippingTwd: 0 }, Date.now());

    const results = await Promise.all([commit("late_success_unreclaimable", 300), commit("cancelled_order", 300), commit("duplicate_success", 300)]);

    expect(results.filter((id) => id !== null)).toHaveLength(2);
    const total = (await env.DB.prepare("SELECT SUM(amount_twd) AS total FROM refunds").first<{ total: number }>())!.total;
    expect(total).toBe(600);
    expect(total).toBeLessThanOrEqual(payment.amount_twd);
    // 新紀錄的閘道退款 ID 隨 INSERT 寫入、彼此不同
    const ids = (await env.DB.prepare("SELECT gateway_refund_id AS g FROM refunds").all<{ g: string }>()).results.map((row) => row.g);
    expect(new Set(ids).size).toBe(2);
    expect(ids.every((id) => /^rf_[0-9a-f-]{36}$/.test(id))).toBe(true);
  });

  it("佔用額度含尚未成功的退款：失敗那筆仍占額度，不足的承諾回 null", async () => {
    const { orderId, gateway, settleFirst } = await twoLatePayments();
    gateway.failNextRefundExplicitly();
    await app.applyPaymentResult(settleFirst());
    const [failed] = await adminRefunds(orderId);

    const over = await commitRefund(env.DB, { paymentId: failed!.paymentId, reason: "duplicate_success", amountTwd: 1, goodsTwd: 1, shippingTwd: 0 }, Date.now());

    expect(over).toBeNull();
  });
});

describe("登記時的衝突處理", () => {
  it("同一付款同一原因已有退款（部分唯一索引）才靜默回既有那筆；其他唯一衝突（閘道退款 ID）要丟錯，不能靜默回 null", async () => {
    const { orderId, gateway, settleFirst } = await twoLatePayments();
    gateway.failNextRefundExplicitly();
    await app.applyPaymentResult(settleFirst());
    const [existing] = await adminRefunds(orderId);
    expect(await registerPaymentRefund(env.DB, existing!.paymentId, "cancelled_order", Date.now())).toBe(existing!.id);

    // 預先放一筆佔著閘道退款 ID 的列，並讓新退款產生同一個 ID：登記必須丟錯，不能靜默回 null
    const other = await env.DB.prepare("SELECT id FROM payments WHERE order_id = ? AND id <> ?").bind(orderId, existing!.paymentId).first<{ id: number }>();
    await env.DB.prepare("UPDATE refunds SET gateway_refund_id = 'rf_taken' WHERE id = ?").bind(existing!.id).run();
    vi.spyOn(crypto, "randomUUID").mockReturnValue("taken" as ReturnType<typeof crypto.randomUUID>);
    await env.DB.prepare("UPDATE payments SET status = 'succeeded' WHERE id = ?").bind(other!.id).run();

    await expect(registerPaymentRefund(env.DB, other!.id, "duplicate_success", Date.now())).rejects.toThrow(/UNIQUE/);
  });

  it("閘道退款 ID 不可為空字串", async () => {
    const { orderId, settleFirst } = await twoLatePayments();
    await app.applyPaymentResult(settleFirst());
    const [refund] = await adminRefunds(orderId);

    await expect(env.DB.prepare("UPDATE refunds SET gateway_refund_id = '' WHERE id = ?").bind(refund!.id).run()).rejects.toThrow(/CHECK/);
  });
});
