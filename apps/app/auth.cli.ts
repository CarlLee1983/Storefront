// 只給 `bun run auth:generate` 使用的設定檔，不進 Worker bundle、不被 src/ 引用。
// Better Auth CLI 需要一個能在 Node 載入的 `auth` 匯出，用它推導 schema。
// 設定直接由 createAuth 產生（單一來源），這裡只提供明顯是假的 placeholder 設定與 D1，
// 所以影響 schema 的選項（plugins、rateLimit.storage…）改在 src/auth/auth.ts 即可。
// CLI 版本（package.json 的 auth:generate）與 better-auth 依賴都釘死 1.7.6，升級時兩處一起改。
import { createAuth } from "./src/auth/auth";

export const auth = createAuth(
  {
    baseURL: "http://localhost:4321",
    secret: "cli-placeholder-not-a-secret-never-used-at-runtime",
    google: { clientId: "cli-placeholder", clientSecret: "cli-placeholder" },
    line: { clientId: "cli-placeholder", clientSecret: "cli-placeholder" },
  },
  {} as D1Database,
);
