// ACCESS_DEV_JWT 只允許出現在本機 .dev.vars（已 gitignore），不寫進 wrangler.jsonc，
// 所以 `wrangler types` 不會產生它；型別在這裡補上（必為選用）。
declare namespace Cloudflare {
  interface Env {
    ACCESS_DEV_JWT?: string;
  }
}

interface Env {
  ACCESS_DEV_JWT?: string;
}

// 由 src/middleware.ts 依 cookie 向 App Worker 查詢；null = 未登入
declare namespace App {
  interface Locals {
    customer: Awaited<ReturnType<Env["APP"]["getCustomerSession"]>>["customer"];
  }
}
