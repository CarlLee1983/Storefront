// GATEWAY_API_KEY 是 secret，不寫進 wrangler.jsonc，所以 `wrangler types` 不會產生它；型別在這裡補上（必為選用，缺少時付款 RPC fail closed）。
declare namespace Cloudflare {
  interface Env {
    GATEWAY_API_KEY?: string;
  }
}

interface Env {
  GATEWAY_API_KEY?: string;
}
