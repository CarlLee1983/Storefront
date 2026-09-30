import { signWebhook, SIGNATURE_HEADER } from "@storefront/gateway/webhook-signature";
import { describe, expect, it, vi } from "vitest";
import { handlePaymentWebhook, type ApplyPaymentResult } from "./webhook";

const SECRET = "webhook-secret-for-test";
const NOW = Date.UTC(2026, 8, 30, 12, 0, 0);

const succeeded = {
  eventId: "evt_1",
  type: "payment.succeeded",
  paymentId: "pay_1",
  merchantReference: "12",
  amountTwd: 640,
  occurredAt: NOW,
};

async function signedRequest(payload: unknown, { secret = SECRET, signedAt = NOW, body }: { secret?: string; signedAt?: number; body?: string } = {}) {
  const text = body ?? JSON.stringify(payload);
  const signature = await signWebhook({ secret, body: text, nowMs: signedAt });
  return new Request("https://shop.example/api/payments/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json", [SIGNATURE_HEADER]: signature },
    body: text,
  });
}

function setup(result: Awaited<ReturnType<ApplyPaymentResult>> = { ok: true }) {
  const apply = vi.fn<ApplyPaymentResult>(async () => result);
  // 第二個參數明確傳 undefined 表示「沒有設定 secret」，所以用 rest 參數的長度區分「沒傳」
  const handle = (request: Request, ...secret: [string | undefined] | []) =>
    handlePaymentWebhook(request, { secret: secret.length > 0 ? secret[0] : SECRET, nowMs: NOW, apply });
  return { apply, handle };
}

describe("handlePaymentWebhook：驗簽", () => {
  it("簽章正確的 payment.succeeded：轉交 App 套用（付款 ID 是閘道付款 ID），回 200", async () => {
    const { apply, handle } = setup();

    const response = await handle(await signedRequest(succeeded));

    expect(response.status).toBe(200);
    expect(apply).toHaveBeenCalledExactlyOnceWith({ eventId: "evt_1", gatewayPaymentId: "pay_1", outcome: "succeeded" });
  });

  it("payment.failed：outcome 是 failed", async () => {
    const { apply, handle } = setup();

    await handle(await signedRequest({ ...succeeded, type: "payment.failed" }));

    expect(apply).toHaveBeenCalledExactlyOnceWith({ eventId: "evt_1", gatewayPaymentId: "pay_1", outcome: "failed" });
  });

  it("簽章錯誤（用別的 secret 簽）：400，不轉交", async () => {
    const { apply, handle } = setup();

    const response = await handle(await signedRequest(succeeded, { secret: "someone-elses-secret" }));

    expect(response.status).toBe(400);
    expect(apply).not.toHaveBeenCalled();
  });

  it("本文被竄改（簽章是對原文簽的）：400，不轉交", async () => {
    const { apply, handle } = setup();
    const genuine = await signedRequest(succeeded);
    const tampered = new Request(genuine.url, {
      method: "POST",
      headers: genuine.headers,
      body: JSON.stringify({ ...succeeded, amountTwd: 1 }),
    });

    expect((await handle(tampered)).status).toBe(400);
    expect(apply).not.toHaveBeenCalled();
  });

  it("沒有簽章 header：400，不轉交", async () => {
    const { apply, handle } = setup();

    const response = await handle(new Request("https://shop.example/api/payments/webhook", { method: "POST", body: JSON.stringify(succeeded) }));

    expect(response.status).toBe(400);
    expect(apply).not.toHaveBeenCalled();
  });

  it("簽章時間超出容忍度（重放）：400，不轉交", async () => {
    const { apply, handle } = setup();

    const response = await handle(await signedRequest(succeeded, { signedAt: NOW - 10 * 60 * 1000 }));

    expect(response.status).toBe(400);
    expect(apply).not.toHaveBeenCalled();
  });

  it.each([undefined, ""])("尚未設定 webhook secret（%j）：503 fail closed，不轉交", async (secret) => {
    const { apply, handle } = setup();

    const response = await handle(await signedRequest(succeeded), secret);

    expect(response.status).toBe(503);
    expect(apply).not.toHaveBeenCalled();
  });
});

describe("handlePaymentWebhook：內容與 App 的回應", () => {
  it("payment.refunded 等不需要套用的事件：簽章正確就回 200（讓閘道視為送達），不轉交", async () => {
    const { apply, handle } = setup();

    const response = await handle(await signedRequest({ ...succeeded, type: "payment.refunded" }));

    expect(response.status).toBe(200);
    expect(apply).not.toHaveBeenCalled();
  });

  const invalidBodies: [string, { payload?: unknown; body?: string }][] = [
    ["不是 JSON", { body: "not json" }],
    ["缺 eventId", { payload: { ...succeeded, eventId: undefined } }],
    ["paymentId 不是字串", { payload: { ...succeeded, paymentId: 5 } }],
    ["type 不是字串", { payload: { ...succeeded, type: undefined } }],
    ["本文是陣列", { payload: [] }],
  ];
  it.each(invalidBodies)("簽章正確但內容不合法（%s）：400，不轉交", async (_label, { payload, body }) => {
    const { apply, handle } = setup();

    const response = await handle(await signedRequest(payload, { body }));

    expect(response.status).toBe(400);
    expect(apply).not.toHaveBeenCalled();
  });

  it.each([
    [{ ok: false, reason: "payment_not_found" }, 404],
    [{ ok: false, reason: "invalid_input" }, 400],
    [{ ok: false, reason: "something_else" }, 500],
  ] as const)("App 回 %j：對應 HTTP %i（非 2xx，閘道不會當成已送達）", async (result, status) => {
    const { handle } = setup(result);

    expect((await handle(await signedRequest(succeeded))).status).toBe(status);
  });
});
