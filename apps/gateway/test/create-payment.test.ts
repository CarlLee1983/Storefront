import { beforeEach, describe, expect, it } from "vitest";
import { setNow } from "./clock";
import { api, bearer, createPayment, ORIGIN, resetDb, RETURN_URL, WEBHOOK_URL } from "./helpers";

const NOW = 1_800_000_000_000;

const valid = { merchantReference: "order-42", amountTwd: 640, returnUrl: RETURN_URL, webhookUrl: WEBHOOK_URL };

describe("建立付款 POST /v1/payments", () => {
  beforeEach(resetDb);

  it("回傳付款 ID、付款頁網址與 10 分鐘後的失效時間", async () => {
    setNow(NOW);

    const response = await api("POST", "/v1/payments", valid);

    expect(response.status).toBe(201);
    const { ok, data } = (await response.json()) as { ok: boolean; data: Record<string, unknown> };
    expect(ok).toBe(true);
    expect(data).toEqual({
      paymentId: expect.stringMatching(/^pay_[0-9a-f]{32}$/),
      paymentUrl: `${ORIGIN}/pay/${data.paymentId}`,
      expiresAt: NOW + 10 * 60_000,
    });
  });

  it("沒有金鑰、金鑰錯誤都回 401 unauthorized", async () => {
    const missing = await api("POST", "/v1/payments", valid, {});
    const wrong = await api("POST", "/v1/payments", valid, bearer("wrong-key"));

    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ ok: false, error: { code: "unauthorized", message: expect.any(String) } });
    expect(wrong.status).toBe(401);
  });

  it.each([
    ["金額為 0", { amountTwd: 0 }, "amountTwd"],
    ["金額為負數", { amountTwd: -5 }, "amountTwd"],
    ["金額不是整數", { amountTwd: 10.5 }, "amountTwd"],
    ["缺少 merchantReference", { merchantReference: "" }, "merchantReference"],
    ["returnUrl 不是 http(s) 網址", { returnUrl: "javascript:alert(1)" }, "returnUrl"],
    ["webhookUrl 不是網址", { webhookUrl: "not a url" }, "webhookUrl"],
  ])("%s：回 400 invalid_input 並指出欄位", async (_name, override, field) => {
    const response = await api("POST", "/v1/payments", { ...valid, ...override });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { ok: false; error: { code: string; fields: Record<string, string[]> } };
    expect(body.error.code).toBe("invalid_input");
    expect(Object.keys(body.error.fields)).toContain(field);
  });

  it("body 不是 JSON 時回 400 invalid_input", async () => {
    const response = await api("POST", "/v1/payments", undefined);

    expect(response.status).toBe(400);
  });

  it("每次建立的付款 ID 都不同", async () => {
    const [a, b] = [await createPayment(), await createPayment()];

    expect(a.paymentId).not.toBe(b.paymentId);
  });
});
