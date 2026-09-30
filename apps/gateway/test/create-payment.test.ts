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

  it("帶 expiresAt（epoch 毫秒）：實際失效時間是 min(建立時間 + 10 分鐘, expiresAt)", async () => {
    setNow(NOW);
    const early = NOW + 2 * 60_000;
    const late = NOW + 60 * 60_000;

    const capped = (await (await api("POST", "/v1/payments", { ...valid, expiresAt: early })).json()) as { data: { expiresAt: number } };
    const notCapped = (await (await api("POST", "/v1/payments", { ...valid, expiresAt: late })).json()) as { data: { expiresAt: number } };

    expect(capped.data.expiresAt).toBe(early);
    expect(notCapped.data.expiresAt).toBe(NOW + 10 * 60_000);
  });

  it.each([
    ["早於現在", NOW - 1],
    ["等於現在", NOW],
    ["不是整數", NOW + 1.5],
    ["不是數字", "tomorrow"],
  ])("expiresAt %s：400 invalid_input，欄位是 expiresAt", async (_label, expiresAt) => {
    setNow(NOW);

    const response = await api("POST", "/v1/payments", { ...valid, expiresAt });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: "invalid_input", fields: { expiresAt: expect.any(Array) } } });
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
