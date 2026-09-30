// ACCESS_JWKS_JSON 只允許出現在本機 .dev.vars 與測試，不寫進 wrangler.jsonc，
// 所以 `wrangler types` 不會產生它；型別在這裡補上（必為選用）。
// 內嵌 JWKS：僅供本機開發與測試，設了就不會去抓 Access 的 certs 端點。
declare namespace Cloudflare {
  interface Env {
    ACCESS_JWKS_JSON?: string;
  }
}

interface Env {
  ACCESS_JWKS_JSON?: string;
}
