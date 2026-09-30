import { beforeEach, describe, expect, it } from "vitest";
import { setNow } from "./clock";
import { api, bearer, captureWebhooks, createPayment, resetDb, submitPayPage } from "./helpers";

const NOW = 1_800_000_000_000;

const statusOf = async (paymentId: string) =>
  ((await (await api("GET", `/v1/payments/${paymentId}`)).json()) as { data: { status: string } }).data.status;

async function succeededPayment(overrides: Record<string, unknown> = {}) {
  const { paymentId } = await createPayment(overrides);
  await submitPayPage(paymentId, { outcome: "success", timing: "immediate" });
  return paymentId;
}

describe("退款 POST /v1/payments/:id/refund", () => {
  beforeEach(resetDb);

  it("成功的付款可以退款：狀態變 refunded，並送出簽章的 payment.refunded", async () => {
    const webhooks = captureWebhooks();
    const paymentId = await succeededPayment({ amountTwd: 640, merchantReference: "order-42" });
    setNow(NOW);

    const response = await api("POST", `/v1/payments/${paymentId}/refund`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, data: { paymentId, status: "refunded" } });
    expect(await statusOf(paymentId)).toBe("refunded");
    expect(webhooks.map((w) => w.event.type)).toEqual(["payment.succeeded", "payment.refunded"]);
    expect(webhooks[1]!.event).toMatchObject({ paymentId, amountTwd: 640, merchantReference: "order-42", occurredAt: NOW });
    expect(webhooks[1]!.signature).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
  });

  it.each(["pending", "failed", "expired"])("%s 的付款不能退款：回 409 payment_not_refundable", async (state) => {
    captureWebhooks();
    const { paymentId } = await createPayment();
    if (state === "failed") await submitPayPage(paymentId, { outcome: "failure", timing: "immediate" });
    if (state === "expired") await api("POST", `/v1/payments/${paymentId}/cancel`);

    const response = await api("POST", `/v1/payments/${paymentId}/refund`);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: "payment_not_refundable" } });
    expect(await statusOf(paymentId)).toBe(state);
  });

  it("已退款的付款不能再退：回 409，不會多送 webhook", async () => {
    const webhooks = captureWebhooks();
    const paymentId = await succeededPayment();
    await api("POST", `/v1/payments/${paymentId}/refund`);

    const again = await api("POST", `/v1/payments/${paymentId}/refund`);

    expect(again.status).toBe(409);
    expect(webhooks).toHaveLength(2);
  });

  it("建立時設 failNextRefund：第一次退款失敗（502 refund_failed、狀態 refund_failed、無 webhook），重試成功", async () => {
    const webhooks = captureWebhooks();
    const paymentId = await succeededPayment({ failNextRefund: true });

    const failed = await api("POST", `/v1/payments/${paymentId}/refund`);

    expect(failed.status).toBe(502);
    expect(await failed.json()).toMatchObject({ ok: false, error: { code: "refund_failed" } });
    expect(await statusOf(paymentId)).toBe("refund_failed");
    expect(webhooks.map((w) => w.event.type)).toEqual(["payment.succeeded"]);

    const retry = await api("POST", `/v1/payments/${paymentId}/refund`);

    expect(retry.status).toBe(200);
    expect(await statusOf(paymentId)).toBe("refunded");
    expect(webhooks.map((w) => w.event.type)).toEqual(["payment.succeeded", "payment.refunded"]);
  });

  it("不存在的付款回 404；沒有金鑰回 401", async () => {
    captureWebhooks();
    expect((await api("POST", "/v1/payments/pay_missing/refund")).status).toBe(404);
    const paymentId = await succeededPayment();
    expect((await api("POST", `/v1/payments/${paymentId}/refund`, undefined, bearer("nope"))).status).toBe(401);
  });

  it("failNextRefund 必須是布林值", async () => {
    const response = await api("POST", "/v1/payments", {
      merchantReference: "o",
      amountTwd: 1,
      returnUrl: "https://shop.test/r",
      webhookUrl: "https://shop.test/w",
      failNextRefund: "yes",
    });

    expect(response.status).toBe(400);
  });
});
