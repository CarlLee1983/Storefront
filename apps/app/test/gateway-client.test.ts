import { describe, expect, it } from "vitest";
import { createHttpGateway, GATEWAY_TIMEOUT_MS, GatewayError } from "../src/payments/gateway";

const BASE_URL = "https://gateway.example";
const API_KEY = "key-for-test";

interface Recorded {
  url: string;
  method: string;
  authorization: string | null;
  body: unknown;
}

/** 以指定回應充當閘道，並記下收到的請求。 */
function gatewayReplying(respond: () => Response | Promise<Response>) {
  const requests: Recorded[] = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const text = await request.text();
    requests.push({
      url: request.url,
      method: request.method,
      authorization: request.headers.get("Authorization"),
      body: text ? JSON.parse(text) : undefined,
    });
    return respond();
  };
  return { gateway: createHttpGateway({ baseUrl: BASE_URL, apiKey: API_KEY }, fetchImpl), requests };
}

const envelope = (data: unknown, status = 200) => Response.json({ ok: true, data }, { status });
const errorEnvelope = (status: number, code: string) =>
  Response.json({ ok: false, error: { code, message: "說明" } }, { status });

describe("HTTP 閘道：createPayment", () => {
  it("帶 API 金鑰 POST /v1/payments，回傳閘道付款 ID 與付款頁網址", async () => {
    const { gateway, requests } = gatewayReplying(() =>
      envelope({ paymentId: "pay_1", paymentUrl: `${BASE_URL}/pay/pay_1`, expiresAt: 1_000 }, 201),
    );
    const input = {
      merchantReference: "12",
      amountTwd: 775,
      returnUrl: "https://shop.example/orders/12/payment-return",
      webhookUrl: "https://shop.example/api/payments/webhook",
      expiresAt: 1_700_000_000_000,
    };

    expect(await gateway.createPayment(input)).toEqual({ paymentId: "pay_1", paymentUrl: `${BASE_URL}/pay/pay_1`, expiresAt: 1_000 });
    expect(requests).toEqual([{ url: `${BASE_URL}/v1/payments`, method: "POST", authorization: `Bearer ${API_KEY}`, body: input }]);
  });

  it("baseUrl 結尾有斜線也能組出正確網址", async () => {
    const requests: string[] = [];
    const gateway = createHttpGateway({ baseUrl: `${BASE_URL}/`, apiKey: API_KEY }, async (input, init) => {
      requests.push(new Request(input, init).url);
      return envelope({ paymentId: "pay_1", paymentUrl: `${BASE_URL}/pay/pay_1`, expiresAt: 1 }, 201);
    });

    await gateway.createPayment({ merchantReference: "1", amountTwd: 1, returnUrl: "https://a.example", webhookUrl: "https://a.example", expiresAt: 1 });

    expect(requests).toEqual([`${BASE_URL}/v1/payments`]);
  });
});

describe("HTTP 閘道：paymentUrl 的來源", () => {
  it("付款頁網址的 origin 不等於 baseUrl 的 origin：GatewayError（invalid_response），不把顧客導去別的網站", async () => {
    const { gateway } = gatewayReplying(() => envelope({ paymentId: "pay_1", paymentUrl: "https://evil.example/pay/pay_1", expiresAt: 1 }, 201));

    await expect(
      gateway.createPayment({ merchantReference: "1", amountTwd: 1, returnUrl: "https://a.example", webhookUrl: "https://a.example", expiresAt: 1 }),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });
});

describe("HTTP 閘道：getPayment", () => {
  it("GET /v1/payments/:id，回傳狀態與 eventId（尚無事件為 null）", async () => {
    const data = { paymentId: "pay_1", status: "succeeded", amountTwd: 775, merchantReference: "12", expiresAt: 1_000, eventId: "evt_1" };
    const { gateway, requests } = gatewayReplying(() => envelope(data));

    expect(await gateway.getPayment("pay_1")).toEqual(data);
    expect(requests[0]).toMatchObject({ url: `${BASE_URL}/v1/payments/pay_1`, method: "GET", authorization: `Bearer ${API_KEY}` });

    const pending = gatewayReplying(() => envelope({ ...data, status: "pending", eventId: null }));
    expect(await pending.gateway.getPayment("pay_1")).toMatchObject({ status: "pending", eventId: null });
  });
});

describe("HTTP 閘道：refund 與 cancel", () => {
  it("refund：POST /v1/payments/:id/refund，回傳 refunded", async () => {
    const { gateway, requests } = gatewayReplying(() => envelope({ paymentId: "pay_1", status: "refunded" }));

    expect(await gateway.refund("pay_1")).toEqual({ paymentId: "pay_1", status: "refunded" });
    expect(requests[0]).toMatchObject({ url: `${BASE_URL}/v1/payments/pay_1/refund`, method: "POST", authorization: `Bearer ${API_KEY}` });
  });

  it("cancel：POST /v1/payments/:id/cancel，取消後狀態是 expired", async () => {
    const { gateway, requests } = gatewayReplying(() => envelope({ paymentId: "pay_1", status: "expired" }));

    expect(await gateway.cancel("pay_1")).toEqual({ paymentId: "pay_1", status: "expired" });
    expect(requests[0]).toMatchObject({ url: `${BASE_URL}/v1/payments/pay_1/cancel`, method: "POST" });
  });
});

describe("HTTP 閘道：失敗", () => {
  it("閘道回錯誤：丟出 GatewayError，帶 HTTP 狀態與閘道的錯誤碼", async () => {
    const { gateway } = gatewayReplying(() => errorEnvelope(409, "payment_not_refundable"));

    await expect(gateway.refund("pay_1")).rejects.toMatchObject({ name: "GatewayError", status: 409, code: "payment_not_refundable" });
  });

  it("回應不是預期的格式：GatewayError（code invalid_response），不當成成功", async () => {
    const { gateway } = gatewayReplying(() => envelope({ unexpected: true }));

    await expect(gateway.getPayment("pay_1")).rejects.toMatchObject({ code: "invalid_response" });
    const html = gatewayReplying(() => new Response("<html>bad gateway</html>", { status: 502 }));
    await expect(html.gateway.getPayment("pay_1")).rejects.toMatchObject({ code: "invalid_response", status: 502 });
  });

  it("連線失敗：GatewayError（code unreachable），保留原始原因", async () => {
    const cause = new TypeError("fetch failed");
    const gateway = createHttpGateway({ baseUrl: BASE_URL, apiKey: API_KEY }, async () => {
      throw cause;
    });

    const error = await gateway.getPayment("pay_1").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GatewayError);
    expect(error).toMatchObject({ code: "unreachable", status: null, cause });
  });
});

describe("HTTP 閘道：逾時", () => {
  it("閘道永不回應（連 signal 都不理會）：逾時後以 unreachable 失敗，不無限等待", async () => {
    const { gateway } = gatewayReplying(() => new Promise<Response>(() => undefined));

    const started = Date.now();
    const error = await gateway.getPayment("pay_1").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GatewayError);
    expect(error).toMatchObject({ code: "unreachable", status: null });
    expect(Date.now() - started).toBeLessThan(GATEWAY_TIMEOUT_MS + 2_000);
  }, GATEWAY_TIMEOUT_MS + 5_000);
});
