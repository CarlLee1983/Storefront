import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { handlePaymentWebhook } from "../../../payments/webhook";

export const prerender = false;

// 金流閘道回呼付款結果：不需要顧客 session，靠簽章驗證來源；驗簽與轉交都在 handlePaymentWebhook
export const POST: APIRoute = ({ request }) =>
  handlePaymentWebhook(request, {
    secret: env.GATEWAY_WEBHOOK_SECRET,
    nowMs: Date.now(),
    apply: (input) => env.APP.applyPaymentResult(input),
  });
