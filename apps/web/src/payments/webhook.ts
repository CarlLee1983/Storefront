import type { PaymentEvent } from "@storefront/app/payments-shared";
import { verifyWebhookSignature, SIGNATURE_HEADER } from "@storefront/gateway/webhook-signature";

/** App 的 `applyPaymentResult` RPC 的回傳（只用到這裡看得到的欄位）。 */
export type ApplyPaymentResult = (input: PaymentEvent) => Promise<{ ok: true } | { ok: false; reason: string }>;

export interface WebhookDeps {
  /** `GATEWAY_WEBHOOK_SECRET`；沒設定（undefined 或空字串）時 fail closed。 */
  secret: string | undefined;
  nowMs: number;
  apply: ApplyPaymentResult;
}

const OUTCOME_BY_EVENT_TYPE: Record<string, PaymentEvent["outcome"]> = {
  "payment.succeeded": "succeeded",
  "payment.failed": "failed",
};

const text = (status: number, body: string) => new Response(body, { status });

/** 閘道 webhook 本文（已通過驗簽）的必要欄位；不合法回 null。 */
function parsePayload(body: string): { eventId: string; type: string; paymentId: string } | null {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof json !== "object" || json === null) return null;
  const { eventId, type, paymentId } = json as Record<string, unknown>;
  return typeof eventId === "string" && typeof type === "string" && typeof paymentId === "string" ? { eventId, type, paymentId } : null;
}

/**
 * 閘道回呼付款結果的 HTTP 處理：用原始 body 驗簽（失敗回 400、不呼叫 App），通過後把結果轉交 App 的套用 RPC。
 * 回應的狀態碼就是閘道判斷「送達與否」的依據：只有 2xx 算送達，所以 App 找不到付款或發生錯誤時要回非 2xx。
 * 不需要顧客 session；也不會被 Astro 的 checkOrigin 擋：它只擋表單型 Content-Type（閘道送的是 application/json）。
 */
export async function handlePaymentWebhook(request: Request, { secret, nowMs, apply }: WebhookDeps): Promise<Response> {
  if (!secret) {
    console.error(JSON.stringify({ event: "webhook_secret_missing" }));
    return text(503, "Service Unavailable");
  }

  const body = await request.text();
  const verified = await verifyWebhookSignature({ secret, header: request.headers.get(SIGNATURE_HEADER) ?? "", body, nowMs });
  if (!verified.ok) {
    console.warn(JSON.stringify({ event: "webhook_signature_rejected", reason: verified.reason }));
    return text(400, "Invalid signature");
  }

  const payload = parsePayload(body);
  if (!payload) return text(400, "Invalid payload");
  const outcome = OUTCOME_BY_EVENT_TYPE[payload.type];
  // 退款等其他事件本票不處理（#11）：簽章正確就回 200，讓閘道視為送達
  if (!outcome) return text(200, "Ignored");

  const result = await apply({ eventId: payload.eventId, gatewayPaymentId: payload.paymentId, outcome });
  if (result.ok) return text(200, "OK");
  if (result.reason === "payment_not_found") return text(404, "Payment not found");
  if (result.reason === "invalid_input") return text(400, "Invalid payload");
  console.error(JSON.stringify({ event: "webhook_apply_failed", reason: result.reason }));
  return text(500, "Internal Server Error");
}
