import { beforeEach, describe, expect, it } from "vitest";
import { api, basic, bearer, captureWebhooks, createPayment, resetDb, send, submitPayPage } from "./helpers";

const getPayment = async (paymentId: string) =>
  ((await (await api("GET", `/v1/payments/${paymentId}`)).json()) as { data: { status: string; refundedTwd: number } }).data;

const toggleFailNextRefund = (paymentId: string, headers: Record<string, string> = basic()) =>
  send(`/console/payments/${paymentId}/toggle-refund-failure`, { method: "POST", headers, redirect: "manual" });

const refund = (paymentId: string, refundId: string, amountTwd: number) => api("POST", `/v1/payments/${paymentId}/refunds`, { refundId, amountTwd });
const lookup = (paymentId: string, refundId: string) => api("GET", `/v1/payments/${paymentId}/refunds/${refundId}`);

async function succeededPayment(overrides: Record<string, unknown> = {}) {
  const { paymentId } = await createPayment(overrides);
  await submitPayPage(paymentId, { outcome: "success", timing: "immediate" });
  return paymentId;
}

describe("部分退款 POST /v1/payments/:id/refunds", () => {
  beforeEach(resetDb);

  it("同一筆付款可以逐筆部分退款：回成功的退款、累計金額反映在付款上，付款狀態仍是 succeeded", async () => {
    captureWebhooks();
    const paymentId = await succeededPayment({ amountTwd: 1000 });

    const first = await refund(paymentId, "rf_1", 300);
    const second = await refund(paymentId, "rf_2", 700);

    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true, data: { refundId: "rf_1", paymentId, status: "succeeded", amountTwd: 300 } });
    expect(second.status).toBe(200);
    expect(await getPayment(paymentId)).toMatchObject({ status: "succeeded", refundedTwd: 1000 });
  });

  it("累計退款不得超過付款金額：超過回 409 refund_exceeds_payment，且不留下退款", async () => {
    captureWebhooks();
    const paymentId = await succeededPayment({ amountTwd: 1000 });
    await refund(paymentId, "rf_1", 800);

    const over = await refund(paymentId, "rf_2", 300);

    expect(over.status).toBe(409);
    expect(await over.json()).toMatchObject({ ok: false, error: { code: "refund_exceeds_payment" } });
    expect((await lookup(paymentId, "rf_2")).status).toBe(404);
    expect((await refund(paymentId, "rf_3", 200)).status).toBe(200);
    expect((await getPayment(paymentId)).refundedTwd).toBe(1000);
  });

  it("同一個 refundId 重送是冪等的：回同一筆結果，不重複退款", async () => {
    captureWebhooks();
    const paymentId = await succeededPayment({ amountTwd: 1000 });
    await refund(paymentId, "rf_1", 400);

    const again = await refund(paymentId, "rf_1", 400);

    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ data: { refundId: "rf_1", status: "succeeded", amountTwd: 400 } });
    expect((await getPayment(paymentId)).refundedTwd).toBe(400);
  });

  it("同一個 refundId 帶不同金額，或用在別筆付款：回 409 refund_conflict", async () => {
    captureWebhooks();
    const paymentId = await succeededPayment({ amountTwd: 1000 });
    const other = await succeededPayment({ amountTwd: 1000 });
    await refund(paymentId, "rf_1", 400);

    const differentAmount = await refund(paymentId, "rf_1", 500);
    const elsewhere = await refund(other, "rf_1", 400);

    for (const response of [differentAmount, elsewhere]) {
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: "refund_conflict" } });
    }
    expect((await getPayment(paymentId)).refundedTwd).toBe(400);
    expect((await getPayment(other)).refundedTwd).toBe(0);
  });

  it.each(["pending", "failed", "expired"])("%s 的付款不能退款：回 409 payment_not_refundable", async (state) => {
    captureWebhooks();
    const { paymentId } = await createPayment();
    if (state === "failed") await submitPayPage(paymentId, { outcome: "failure", timing: "immediate" });
    if (state === "expired") await api("POST", `/v1/payments/${paymentId}/cancel`);

    const response = await refund(paymentId, "rf_1", 100);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: "payment_not_refundable" } });
    expect((await getPayment(paymentId)).status).toBe(state);
  });

  it.each([
    ["缺少 refundId", { amountTwd: 100 }],
    ["refundId 含不合法字元", { refundId: "a/b", amountTwd: 100 }],
    ["金額不是整數", { refundId: "rf_1", amountTwd: 10.5 }],
    ["金額不是正數", { refundId: "rf_1", amountTwd: 0 }],
  ])("輸入不合法（%s）回 400 invalid_input", async (_label, body) => {
    captureWebhooks();
    const paymentId = await succeededPayment();

    const response = await api("POST", `/v1/payments/${paymentId}/refunds`, body);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_input" } });
  });

  it("退款不送 webhook", async () => {
    const webhooks = captureWebhooks();
    const paymentId = await succeededPayment();

    await refund(paymentId, "rf_1", 100);

    expect(webhooks.map((w) => w.event.type)).toEqual(["payment.succeeded"]);
  });

  it("不存在的付款回 404；沒有金鑰回 401", async () => {
    captureWebhooks();
    expect((await refund("pay_missing", "rf_1", 100)).status).toBe(404);
    const paymentId = await succeededPayment();
    expect((await api("POST", `/v1/payments/${paymentId}/refunds`, { refundId: "rf_1", amountTwd: 100 }, bearer("nope"))).status).toBe(401);
  });
});

describe("明確失敗與重試", () => {
  beforeEach(resetDb);

  it("主控頁切換「下一次退款失敗」：該次回 502 refund_failed、款項不動；用同一個 refundId 重試成功", async () => {
    captureWebhooks();
    const paymentId = await succeededPayment({ amountTwd: 1000 });
    expect((await toggleFailNextRefund(paymentId)).status).toBe(303);
    expect(await (await send("/console", { headers: basic() })).text()).toContain("下一次退款失敗：是");

    const failed = await refund(paymentId, "rf_1", 400);

    expect(failed.status).toBe(502);
    expect(await failed.json()).toMatchObject({ ok: false, error: { code: "refund_failed" } });
    expect(await (await lookup(paymentId, "rf_1")).json()).toMatchObject({ data: { refundId: "rf_1", status: "failed", amountTwd: 400 } });
    expect((await getPayment(paymentId)).refundedTwd).toBe(0);

    const retry = await refund(paymentId, "rf_1", 400);

    expect(retry.status).toBe(200);
    expect(await lookup(paymentId, "rf_1").then((r) => r.json())).toMatchObject({ data: { status: "succeeded" } });
    expect((await getPayment(paymentId)).refundedTwd).toBe(400);
  });

  it("失敗的退款不佔用金額：其他退款可以先用掉額度，重試時再檢查累計上限", async () => {
    captureWebhooks();
    const paymentId = await succeededPayment({ amountTwd: 1000 });
    await toggleFailNextRefund(paymentId);
    await refund(paymentId, "rf_1", 600);
    expect((await refund(paymentId, "rf_2", 700)).status).toBe(200);

    const retry = await refund(paymentId, "rf_1", 600);

    expect(retry.status).toBe(409);
    expect(await retry.json()).toMatchObject({ error: { code: "refund_exceeds_payment" } });
    expect(await lookup(paymentId, "rf_1").then((r) => r.json())).toMatchObject({ data: { status: "failed" } });
  });

  it("再切換一次就取消「下一次退款失敗」；切換需要主控頁認證、付款要存在、來源不能是跨站", async () => {
    captureWebhooks();
    const paymentId = await succeededPayment();
    await toggleFailNextRefund(paymentId);
    await toggleFailNextRefund(paymentId);
    expect((await toggleFailNextRefund(paymentId, {})).status).toBe(401);
    expect((await toggleFailNextRefund("pay_missing")).status).toBe(404);
    expect((await toggleFailNextRefund(paymentId, { ...basic(), Origin: "https://evil.test" })).status).toBe(403);

    expect((await refund(paymentId, "rf_1", 100)).status).toBe(200);
  });

  it("建立付款 API 不接受測試旗標：帶 failNextRefund 也不影響退款", async () => {
    captureWebhooks();
    const paymentId = await succeededPayment({ failNextRefund: true });

    expect((await refund(paymentId, "rf_1", 100)).status).toBe(200);
  });
});

describe("查證 GET /v1/payments/:id/refunds/:refundId", () => {
  beforeEach(resetDb);

  it("回該筆退款的狀態與金額；從未收過的 refundId 回 404 refund_not_found，付款不存在回 404 payment_not_found", async () => {
    captureWebhooks();
    const paymentId = await succeededPayment();
    await refund(paymentId, "rf_1", 250);

    expect(await (await lookup(paymentId, "rf_1")).json()).toEqual({ ok: true, data: { refundId: "rf_1", paymentId, status: "succeeded", amountTwd: 250 } });
    const missing = await lookup(paymentId, "rf_9");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { code: "refund_not_found" } });
    expect(await (await lookup("pay_missing", "rf_1")).json()).toMatchObject({ error: { code: "payment_not_found" } });
  });

  it("退款屬於另一筆付款時查不到", async () => {
    captureWebhooks();
    const paymentId = await succeededPayment();
    const other = await succeededPayment();
    await refund(paymentId, "rf_1", 100);

    expect((await lookup(other, "rf_1")).status).toBe(404);
  });
});
