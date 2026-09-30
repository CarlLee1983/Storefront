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
        data: { paymentId, status: "pending", amountTwd: 990, merchantReference: "order-7", expiresAt },
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
