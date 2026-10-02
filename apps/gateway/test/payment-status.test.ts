import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { setNow } from "./clock";
import { api, bearer, captureWebhooks, createPayment, resetDb, submitPayPage } from "./helpers";

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;

const getStatus = async (paymentId: string) => {
  const response = await api("GET", `/v1/payments/${paymentId}`);
  return { status: response.status, body: (await response.json()) as { ok: boolean; data: Record<string, unknown> } };
};

describe("查詢付款 GET /v1/payments/:id", () => {
  beforeEach(resetDb);

  it("新建立的付款是 pending，帶金額、merchantReference 與失效時間", async () => {
    setNow(NOW);
    const { paymentId, expiresAt } = await createPayment({ amountTwd: 990, merchantReference: "order-7" });

    expect(await getStatus(paymentId)).toEqual({
      status: 200,
      body: {
        ok: true,
        data: { paymentId, status: "pending", amountTwd: 990, merchantReference: "order-7", expiresAt, eventId: null, refundedTwd: 0 },
      },
    });
  });

  it("建立滿 10 分鐘後查到 expired；差 1 毫秒還是 pending", async () => {
    setNow(NOW);
    const { paymentId } = await createPayment();

    setNow(NOW + 10 * MINUTE - 1);
    expect((await getStatus(paymentId)).body.data.status).toBe("pending");
    setNow(NOW + 10 * MINUTE);
    expect((await getStatus(paymentId)).body.data.status).toBe("expired");
  });

  it("不存在的付款回 404 payment_not_found", async () => {
    const response = await api("GET", "/v1/payments/pay_missing");

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: "payment_not_found" } });
  });

  it("沒有金鑰回 401", async () => {
    const { paymentId } = await createPayment();

    expect((await api("GET", `/v1/payments/${paymentId}`, undefined, {})).status).toBe(401);
    expect((await api("GET", `/v1/payments/${paymentId}`, undefined, bearer("nope"))).status).toBe(401);
  });

  it("顧客在付款頁選成功後查到 succeeded", async () => {
    const { paymentId } = await createPayment();
    captureWebhooks();
    await submitPayPage(paymentId, { outcome: "success", timing: "immediate" });

    expect((await getStatus(paymentId)).body.data.status).toBe("succeeded");
  });
});

describe("付款結果事件的 eventId（與 webhook 相同的冪等鍵）", () => {
  beforeEach(resetDb);

  it("成功、失敗後 eventId 等於 webhook 的 eventId；退款不產生新事件，eventId 不變", async () => {
    const webhooks = captureWebhooks();
    const paid = await createPayment();
    await submitPayPage(paid.paymentId, { outcome: "success", timing: "immediate" });
    const failed = await createPayment();
    await submitPayPage(failed.paymentId, { outcome: "failure", timing: "immediate" });

    expect((await getStatus(paid.paymentId)).body.data.eventId).toBe(webhooks[0]!.event.eventId);
    expect((await getStatus(failed.paymentId)).body.data.eventId).toBe(webhooks[1]!.event.eventId);

    await api("POST", `/v1/payments/${paid.paymentId}/refunds`, { refundId: "rf_1", amountTwd: 100 });

    expect((await getStatus(paid.paymentId)).body.data.eventId).toBe(webhooks[0]!.event.eventId);
    expect(webhooks).toHaveLength(2);
  });

  it("eventId 只取成功／失敗事件：舊的 payment.refunded 事件列不會被當成最近事件", async () => {
    const webhooks = captureWebhooks();
    const { paymentId } = await createPayment();
    await submitPayPage(paymentId, { outcome: "success", timing: "immediate" });
    await env.DB.prepare("INSERT INTO events (id, payment_id, type, body, created_at) VALUES ('evt_legacy_refund', ?, 'payment.refunded', '{}', 1)").bind(paymentId).run();

    expect((await getStatus(paymentId)).body.data.eventId).toBe(webhooks[0]!.event.eventId);
  });

  it("延遲回呼還沒送出時，eventId 已經可以查到（之後 webhook 用同一個）", async () => {
    const webhooks = captureWebhooks();
    const { paymentId } = await createPayment();
    await submitPayPage(paymentId, { outcome: "success", timing: "delayed" });

    const eventId = (await getStatus(paymentId)).body.data.eventId;

    expect(eventId).toMatch(/^evt_[0-9a-f]{32}$/);
    expect(webhooks).toHaveLength(0);
  });

  it("取消而失效的付款沒有事件，eventId 是 null", async () => {
    const { paymentId } = await createPayment();
    await api("POST", `/v1/payments/${paymentId}/cancel`);

    expect((await getStatus(paymentId)).body.data.eventId).toBeNull();
  });
});

describe("取消付款 POST /v1/payments/:id/cancel", () => {
  beforeEach(resetDb);

  it("進行中的付款取消後查到 expired，而且不能再從付款頁成功", async () => {
    setNow(NOW);
    const { paymentId } = await createPayment();

    const cancel = await api("POST", `/v1/payments/${paymentId}/cancel`);

    expect(cancel.status).toBe(200);
    expect(await cancel.json()).toEqual({ ok: true, data: { paymentId, status: "expired" } });
    expect((await getStatus(paymentId)).body.data.status).toBe("expired");
    captureWebhooks();
    expect((await submitPayPage(paymentId, { outcome: "success", timing: "immediate" })).status).toBe(409);
    expect((await getStatus(paymentId)).body.data.status).toBe("expired");
  });

  it("已經 expired 的付款再取消仍回 200（冪等）", async () => {
    setNow(NOW);
    const { paymentId } = await createPayment();
    setNow(NOW + 11 * MINUTE);

    const cancel = await api("POST", `/v1/payments/${paymentId}/cancel`);

    expect(cancel.status).toBe(200);
  });

  it("已經 succeeded 的付款不能取消：回 409 payment_not_cancellable，狀態不變", async () => {
    const { paymentId } = await createPayment();
    captureWebhooks();
    await submitPayPage(paymentId, { outcome: "success", timing: "immediate" });

    const cancel = await api("POST", `/v1/payments/${paymentId}/cancel`);

    expect(cancel.status).toBe(409);
    expect(await cancel.json()).toMatchObject({ ok: false, error: { code: "payment_not_cancellable" } });
    expect((await getStatus(paymentId)).body.data.status).toBe("succeeded");
  });

  it("不存在的付款回 404", async () => {
    expect((await api("POST", "/v1/payments/pay_missing/cancel")).status).toBe(404);
  });
});
