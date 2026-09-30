export interface GatewayConfig {
  apiKey: string;
  webhookSecret: string;
}

/** 付款建立後的有效時間；比 App 的付款期限短（ADR 0001 第一道防線），常數只在這裡定義。 */
export const PAYMENT_TTL_MS = 10 * 60_000;

/** 讀取必要秘密；缺少或空字串就回傳缺少的變數名稱（fail closed，不回傳值）。 */
export function readConfig(env: Env): { ok: true; config: GatewayConfig } | { ok: false; missing: string[] } {
  const { GATEWAY_API_KEY: apiKey, GATEWAY_WEBHOOK_SECRET: webhookSecret } = env;
  if (apiKey && webhookSecret) return { ok: true, config: { apiKey, webhookSecret } };
  const missing = [apiKey ? null : "GATEWAY_API_KEY", webhookSecret ? null : "GATEWAY_WEBHOOK_SECRET"];
  return { ok: false, missing: missing.filter((name) => name !== null) };
}
