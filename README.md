# Storefront

以 Cloudflare 服務架設的購物站演練專案：先實作後端（Workers + D1），再做前台與管理後台的 UI。

延續 [Holdfast](https://github.com/CarlLee1983/Holdfast) 的 Cloudflare 全端演練；平台事實與證據等級見 Holdfast 的 [cloudflare-concurrency.md](https://github.com/CarlLee1983/Holdfast/blob/main/docs/research/cloudflare-concurrency.md)。

## 現況

技術棧沿用 Holdfast：Cloudflare Workers + D1，Astro 前台（Web Worker）與業務邏輯（App Worker）拆開。相關決策見 Holdfast 的 ADR：

- [ADR 0005](https://github.com/CarlLee1983/Holdfast/blob/main/docs/adr/0005-web-app-split-via-rpc.md)：Web / App 以 Service Binding RPC 拆分，Web 不直接存取 D1
- [ADR 0006](https://github.com/CarlLee1983/Holdfast/blob/main/docs/adr/0006-toolchain.md)：工具鏈
- [ADR 0007](https://github.com/CarlLee1983/Holdfast/blob/main/docs/adr/0007-admin-behind-cloudflare-access.md)：管理後台放在 Cloudflare Access 後面
- [ADR 0008](https://github.com/CarlLee1983/Holdfast/blob/main/docs/adr/0008-better-auth-in-app-worker.md)：Better Auth 放在 App Worker
- [ADR 0013](https://github.com/CarlLee1983/Holdfast/blob/main/docs/adr/0013-e2e-login-by-writing-session.md)：E2E 以寫入 session 登入，production 沒有測試登入路徑

Storefront 自己的決策記錄在 `docs/adr/`；工作項目以 issue #1 為總規格，逐張工單實作。

## 顧客登入

顧客用 LINE 或 Google 登入（Better Auth，放在 App Worker；Web 只把 `/api/auth/*` 轉給 App）。設定分兩處：

- `BETTER_AUTH_URL`：純文字 var，填在 `apps/app/wrangler.jsonc` 各環境，必須等於 `apps/web/wrangler.jsonc` 該環境 `routes` 的自訂網域（`https://<網域>`，無結尾斜線）。
- Worker secrets（每個環境各設一次，`bunx wrangler secret put <名稱> --env <preview|production>`，於 `apps/app` 執行）：`BETTER_AUTH_SECRET`（至少 32 字元）、`GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`、`LINE_CHANNEL_ID`、`LINE_CHANNEL_SECRET`。
- Google 與 LINE 後台各登記 callback：`https://<網域>/api/auth/callback/google`、`https://<網域>/api/auth/callback/line`（本機為 `http://localhost:4321`）。

設定缺漏只讓登入不可用（`/api/auth/*` 回 503），其餘頁面照常。部署流程會在 migration 之前用 `apps/app/scripts/check-auth-deploy.ts` 檢查 `BETTER_AUTH_URL` 與 secrets 名稱是否齊全。本機開發見 `apps/app/.dev.vars.example`。
