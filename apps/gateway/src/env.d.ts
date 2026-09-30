// Worker secrets 不在 wrangler.jsonc 裡，`wrangler types` 不會產生它們；缺少時值為 undefined（readConfig 會 fail closed）。
interface Env {
  GATEWAY_API_KEY?: string;
  GATEWAY_WEBHOOK_SECRET?: string;
}
