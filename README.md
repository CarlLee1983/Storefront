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

## 付款

顧客在訂單頁按「前往付款」→ App 向閘道建立付款 → 導向閘道付款頁；結果由兩條路徑確認，共用同一個冪等的「套用付款結果」（以閘道事件 ID 去重）：閘道 webhook（Web 的 `POST /api/payments/webhook`，驗簽後轉給 App）為主，顧客被導回 `/orders/:id/payment-return?paymentId=…` 時 App 再主動向閘道查詢一次。付款成功依訂單當下的狀態分流（都只由搶到事件 ID 的那次呼叫執行一次）：待付款轉已付款；已逾期則在同一個 batch 內以條件式語句「重新保留」庫存（每一筆明細的可售數量都夠才轉已付款並扣在庫數，全有全無），見 ADR 0001；重新保留不到、落在已取消的訂單、或同一張訂單的第二筆成功付款，則付款記為成功、訂單不動，並在 batch 之外向閘道退款。退款結果記在付款上：狀態 `refunded`／`refund_failed`、原因 `late_success_unreclaimable`／`cancelled_order`／`duplicate_success`、時間。退款失敗只記錄與結構化 log（`payment_refund_failed`），不自動重試，管理員之後在後台處理；閘道退款是冪等的。

付款的失效時間取「發起後 10 分鐘」與「付款期限前 2 分鐘」較早者，付款期限前 2 分鐘內不能再發起付款（`payment_window_closed`，ADR 0001 第一道防線）；閘道回的失效時間不早於付款期限視為回應不合法。訂單以 `orders.paid_by_payment_id` 記錄由哪一筆付款支付；後台訂單清單與明細對「付款成功卻沒有退款紀錄、訂單不是由它支付」或 `refund_failed` 的付款標示「需要處理」。

顧客取消待付款訂單時，先讓進行中的付款全部失效（向閘道取消；回 409 就查詢並套用閘道結果，其實已成功則訂單轉已付款、取消被拒），閘道連不上則不取消訂單。

設定（缺少時只有付款不可用，其餘頁面照常；部署前檢查同上，見 `apps/app/scripts/check-auth-deploy.ts`）：

- App：`GATEWAY_BASE_URL`（`apps/app/wrangler.jsonc` 各環境的 vars，閘道 Worker 的網址）與 secret `GATEWAY_API_KEY`（= 閘道的 `GATEWAY_API_KEY`）。閘道導回與 webhook 的網址由 `BETTER_AUTH_URL`（Web 的公開 origin）組成。缺少時 `startPayment`、`confirmPayment` 回 `payment_unavailable`。
- Web：secret `GATEWAY_WEBHOOK_SECRET`（= 閘道的 `GATEWAY_WEBHOOK_SECRET`），於 `apps/web` 執行 `bunx wrangler secret put GATEWAY_WEBHOOK_SECRET --env <preview|production>`。缺少時 webhook 端點回 503，導回查詢仍可讓顧客看到最新狀態。

本機開發見 `apps/app/.dev.vars.example` 與 `apps/web/.dev.vars.example`。

## 模擬金流閘道

`apps/gateway`（`@storefront/gateway`）是獨立的 Worker，自己的 D1，模擬「外部」金流閘道；本站只透過 HTTP API 與簽章 webhook 和它互動。本機以 `bun run dev:gateway` 啟動（`bun run db:migrate` 會一併套用它的 migration），設定見 `apps/gateway/.dev.vars.example`。

- Worker secrets（每個環境各設一次，於 `apps/gateway` 執行 `bunx wrangler secret put <名稱> --env <preview|production>`）：`GATEWAY_API_KEY`、`GATEWAY_WEBHOOK_SECRET`。缺少任一個時所有請求回 503（fail closed）。
- `apps/gateway/wrangler.jsonc` 各環境的 `routes` 網域與 D1 `database_id`（`REPLACE_WITH_` 開頭）部署前要填入；付款頁由顧客的瀏覽器直接開啟，所以需要自訂網域。

API（JSON，`Authorization: Bearer <GATEWAY_API_KEY>`；回應 `{ ok: true, data }` 或 `{ ok: false, error: { code, message, fields? } }`）：

| 路徑 | 說明 |
| --- | --- |
| `POST /v1/payments` | `{ merchantReference, amountTwd, returnUrl, webhookUrl, expiresAt? }` → 201 `{ paymentId, paymentUrl, expiresAt }`。10 分鐘後失效（`src/config.ts` 的 `PAYMENT_TTL_MS`）；可選的 `expiresAt`（epoch 毫秒，必須晚於現在，否則 400）讓付款最晚在那個時間失效，實際失效時間是兩者較早者 |
| `GET /v1/payments/:id` | `{ paymentId, status, amountTwd, merchantReference, expiresAt, eventId }`；`status` 為 `pending / succeeded / failed / expired / refunded / refund_failed`。`eventId` 是最近一個事件（成功／失敗／退款）的 ID，與 webhook 的 `eventId` 相同，供導回查詢與 webhook 共用冪等鍵；沒有事件（pending、取消而失效）為 `null` |
| `POST /v1/payments/:id/cancel` | 讓進行中的付款失效：取消後狀態就是 `expired`（沒有獨立的 cancelled 狀態，也不產生事件）；已 `expired` 冪等成功，已有結果者 409 `payment_not_cancellable` |
| `POST /v1/payments/:id/refund` | 只有 `succeeded`（或可重試的 `refund_failed`）可退；成功送 `payment.refunded`；已 `refunded` 再退冪等回 200 `refunded`（不再送事件）。失敗回 502 `refund_failed`；其他狀態 409 `payment_not_refundable` |

付款頁 `GET /pay/:id`（免認證）讓顧客選成功／失敗、立即／延遲回呼、是否重複回呼、是否「不導回」（模擬顧客關閉視窗：不 303，只顯示「付款已完成，您可以關閉此頁」，搭配延遲回呼即可在瀏覽器重現遲到的付款成功），否則送出後 303 導回 `returnUrl?paymentId=...`。延遲回呼只記錄事件、不送；開發主控頁 `GET /console`（HTTP Basic，帳號任意、密碼為 `GATEWAY_API_KEY`）可對任一事件「立即送出」或「重送」，用來確定地重現遲到的付款成功與重複回呼。主控頁也能對每筆付款切換「下一次退款失敗」：切換後該筆付款的下一次退款回 502 `refund_failed`（狀態 `refund_failed`），旗標隨即消耗，重試即成功。

Webhook：`POST <webhookUrl>`，本文 `{ eventId, type, paymentId, merchantReference, amountTwd, occurredAt }`（`type` 為 `payment.succeeded / payment.failed / payment.refunded`；`occurredAt` 是事件建立時間的 epoch 毫秒，重送不變）。Header `Gateway-Signature: t=<unix 秒>,v1=<hex(HMAC-SHA256(GATEWAY_WEBHOOK_SECRET, "<t>.<原始 body>"))>`，`t` 是每次投遞當下的時間。接收端用 `@storefront/gateway/webhook-signature` 的 `verifyWebhookSignature` 驗證（預設容忍 5 分鐘），並以 `eventId` 去重。
