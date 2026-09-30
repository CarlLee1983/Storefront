import { env, exports } from "cloudflare:workers";
import { afterEach, vi } from "vitest";
import { TEST_API_KEY } from "./constants";

export const ORIGIN = "https://gateway.test";
export const RETURN_URL = "https://shop.test/orders/42/return";
export const WEBHOOK_URL = "https://shop.test/api/webhooks/gateway";

const gateway = exports.default;

export const send = (path: string, init?: RequestInit) => gateway.fetch(new Request(`${ORIGIN}${path}`, init));

/** 每個測試開始前清空閘道的資料；只做測試隔離，斷言一律走 HTTP。 */
export async function resetDb(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM deliveries"),
    env.DB.prepare("DELETE FROM events"),
    env.DB.prepare("DELETE FROM payments"),
  ]);
}

export const bearer = (key = TEST_API_KEY) => ({ Authorization: `Bearer ${key}` });

/** 以 Bearer 金鑰呼叫 JSON API。 */
export function api(method: string, path: string, body?: unknown, headers: Record<string, string> = bearer()) {
  return send(path, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export interface CreatedPayment {
  paymentId: string;
  paymentUrl: string;
  expiresAt: number;
}

export async function createPayment(overrides: Record<string, unknown> = {}): Promise<CreatedPayment> {
  const response = await api("POST", "/v1/payments", {
    merchantReference: "order-42",
    amountTwd: 640,
    returnUrl: RETURN_URL,
    webhookUrl: WEBHOOK_URL,
    ...overrides,
  });
  if (response.status !== 201) throw new Error(`建立付款失敗：${response.status} ${await response.text()}`);
  return ((await response.json()) as { data: CreatedPayment }).data;
}

/** 送出付款頁表單（顧客在瀏覽器按下按鈕）；不自動跟隨導向。 */
export function submitPayPage(paymentId: string, fields: Record<string, string>) {
  return send(`/pay/${paymentId}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
    redirect: "manual",
  });
}

export interface CapturedWebhook {
  url: string;
  body: string;
  signature: string | null;
  redirect: string;
  event: { eventId: string; type: string; paymentId: string; merchantReference: string; amountTwd: number; occurredAt: number };
}

/**
 * 攔截對外的 webhook 投遞（POST 到 WEBHOOK_URL）並記錄；`respond` 決定呼叫端的回應。
 * 其他請求照常送出。
 */
export function captureWebhooks(respond: () => Response | Promise<Response> = () => new Response("ok")) {
  const captured: CapturedWebhook[] = [];
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (request.url !== WEBHOOK_URL) return realFetch(input, init);
    const body = await request.text();
    captured.push({
      url: request.url,
      body,
      signature: request.headers.get("Gateway-Signature"),
      redirect: init?.redirect ?? request.redirect,
      event: JSON.parse(body),
    });
    return respond();
  });
  return captured;
}

/** 主控頁用的 Basic 認證 header：帳號任意，密碼是 API 金鑰。 */
export const basic = (key = TEST_API_KEY) => ({ Authorization: `Basic ${btoa(`console:${key}`)}` });

afterEach(() => vi.restoreAllMocks());
