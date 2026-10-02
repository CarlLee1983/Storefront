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

## 靜物 / Still Life

前台採用「靜物 / Still Life」品牌，文案依 #83 審閱稿落地。頁首顯示 Still Life，瀏覽器標題、描述與分享預覽使用靜物；商品與分類頁分別以商品封面、分類圖片作分享圖片，沒有圖片時使用品牌圖。共用版面提供 canonical、OG、Twitter 卡片、SVG 與 PNG favicon、apple-touch-icon 和 theme-color。

關於、常見問題、退換貨說明與錯誤頁提供購物說明和恢復出口；頁尾提供分類、全部商品、我的訂單與 `hello@gravito.dev` 聯絡方式，並明示「示範網站，不實際出貨」。示範商品的尺寸、材質是核可的展示資料，並非實體商品的量測或驗證結果；仍放在既有說明欄位，重跑本機或 preview seed 即會對齊 catalog。

#85–#88 的檢查結果、32 件商品重新植入驗證與手機／桌機截圖見[驗收紀錄](docs/acceptance/still-life-85-88.md)。

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

## E2E

`e2e/`（`@storefront/e2e`）用 Playwright 跑一條關鍵流程，確認三個 Worker 真正串在一起：管理員（Access JWT）建立分類與分類圖片、上架並補貨、標原價與精選 → 顧客從首頁精選、分類方塊與導覽列進入分類頁，排序、篩選、載入更多、搜尋、看特價頁 → 顧客登入、加入購物車、結帳 → 在模擬閘道付款頁選成功與立即回呼 → 閘道送出真的簽章 webhook 並導回、訂單頁顯示已付款 → 管理員在 `/admin/orders` 出貨 → 顧客看到已出貨與物流單號。webhook 驗簽與導回查詢都不 mock。

```sh
bunx playwright install chromium   # 第一次執行前安裝瀏覽器
bun run e2e
```

`bun run e2e` 由 Playwright 的 `webServer` 執行 `e2e/harness/serve.ts`：每次都清掉 `.wrangler/e2e/`、建置 Web、對 App 與閘道各自的本機 D1 重新套用 migration，再以 `wrangler dev` 跑 Web + App（埠 8790）與閘道（埠 8791）。不會動到開發中的 `.wrangler/state` 與任何 `.dev.vars`；secrets 是 `e2e/harness/constants.ts` 的明顯假值，只寫進 `.wrangler/e2e/` 下自己產生的 `.dev.vars`。

- 顧客登入沿用 Holdfast ADR 0013：harness 直接把 `user` 與 `session` 寫進 E2E 專用的本機 D1，並用測試的 `BETTER_AUTH_SECRET` 簽 cookie；production 沒有任何測試登入路徑。
- 管理員以 `Cf-Access-Jwt-Assertion` header 帶 harness 簽的 Access JWT（與 Cloudflare Access 相同），App 以內嵌 JWKS 驗簽；E2E 跑的是 production 建置，Web 不讀 `ACCESS_DEV_JWT`。
- 失敗時 trace 與報告在 `e2e/test-results/`、`e2e/playwright-report/`（已 gitignore），CI 會上傳成 artifact。
- 需要 8790、8791 與 9330、9331 埠空閒。

## 後台版面

所有後台頁面使用 `AdminLayout.astro`：內容容器上限 90rem，導覽以 `aria-current` 標示所在區域，品牌回到商品管理，另有「前往前台」連結；保留 `noindex`，不顯示前台頁尾。手機導覽維持單行並可水平捲動。

共用後台樣式集中在 `apps/web/src/styles/admin.css`，以 `.admin-shell` 限定作用範圍並沿用前台設計 token。欄位上限 40rem、篩選選單上限 15rem，輸入框與選單等高，動作列有固定間距，連結與控制項至少 44px。前台的全域表單與表格規則維持原樣。`e2e/tests/admin-shell.spec.ts` 在 375 與 1280 寬度驗證所有後台頁面的版面與 axe，包含已付款訂單、403 與 404。

商品管理表格依內容配置欄寬，顯示售價與原價，不顯示說明全文；數字靠右，庫存錯誤顯示在列表上方並與對應輸入框關聯。小於 48rem 時，同一份商品資料與操作表單排列成卡片。從商品管理頂端的「新增商品」進入 `/admin/products/new`，建立後到該商品的編輯頁，接著設定分類與上傳圖片。

新增分類集中在 `/admin/categories`；分類列表在手機以單欄排列，修改與刪除分開。舊 `/admin` 新增商品、建立分類 POST 不再接受；seed 與 E2E 需使用新路由。這些變更不需要資料遷移，回滾時應一併回滾後台頁面、seed 與 E2E 呼叫端。

本機驗證結果與既有前台圖庫滑動測試的限制見 [#77 驗收紀錄](docs/acceptance/77-admin-shell.md)。

商品列表及新增流程的幾何、授權與兩次 seed 驗證，以及同步前台改動的測試限制，見 [#78–#81 驗收紀錄](docs/acceptance/78-admin-products-dag.md)。

## 示範資料

`demo/catalog.json` 與 `demo/images/` 是示範用的 4 個分類與 32 件商品（#50）。`bun run seed` 以瀏覽器操作後台，走真實流程寫入：建立分類並上傳分類圖片、建立商品、補足庫存、上傳商品圖片（瀏覽器縮放、存進 R2）、設定分類、原價與精選，最後上架。以分類代稱與商品名稱判斷是否已存在，重跑只補缺的部分，不產生重複資料；中途失敗直接重跑即可接續。

```sh
bunx playwright install chromium        # 第一次執行前安裝瀏覽器
bun run seed local                      # 本機，預設 http://localhost:4321（bun run dev）
bun run seed local http://localhost:8787 # 本機的其他網址（例如 bun run preview）
bun run seed preview                    # https://storefront-preview.gravito.dev
```

- 目標只接受 `local`（且網址必須是 localhost / 127.0.0.1）與 `preview`；`production` 或其他值在開瀏覽器之前就拒絕，不會有任何寫入。寫入前也會確認對方真的是本站的商品管理頁，避免本機埠被其他專案的 dev server 佔用時寫錯地方。
- 本機：先執行 `bun run admin:dev-token`（缺少時 seed 直接停止）並重新啟動伺服器。seed 會把 `apps/web/.dev.vars` 的 `ACCESS_DEV_JWT` 當成 `Cf-Access-Jwt-Assertion` header 帶上，所以 `bun run dev` 與 `bun run preview`（正式建置，不讀 `ACCESS_DEV_JWT`）都能用。
- preview：會開一個有畫面的 Chrome，由 owner 手動登入 Cloudflare Access，回到 `/admin` 後 seed 自動接手（最多等 15 分鐘）。不使用 service token，因為 App 驗管理員時要求 email claim（#51）。Chrome 設定檔存在 `.wrangler/seed-chrome-preview/`，保留登入狀態，重跑時通常不必再登入。
- 重跑時，已存在的示範商品會對齊清單：說明、售價、原價、分類與精選改回清單的值，被下架的會重新上架；在後台手動改過的示範商品會被蓋掉。庫存例外，只往上補到清單的在庫數，已經比清單多的不會調降。

## 部署

| 環境 | 網址 | 何時部署 |
| --- | --- | --- |
| preview | https://storefront-preview.gravito.dev（模擬閘道 https://storefront-pay-preview.gravito.dev） | push 到 main 自動部署；也可在 Actions 手動觸發 Deploy 並選 `preview`（任何分支） |
| production | https://storefront.gravito.dev（模擬閘道 https://storefront-pay.gravito.dev） | 只能手動觸發 Deploy 並選 `production`，而且限 main 分支 |

部署前的檢查會在套用 migration 之前擋下缺漏的設定，見 `.github/workflows/deploy.yml`。

production 尚未上線。第一次部署前，要先在 Zero Trust 為 `storefront.gravito.dev/admin` 另建一個 Access application，再把它的 AUD 填進 `apps/app/wrangler.jsonc` 的 `env.production.vars.ACCESS_AUD`；目前那裡填的還是 preview application 的 AUD。每個環境各用一個 application：一個 application 掛兩個網域時，Access 登入後可能把瀏覽器導到另一個環境的網域。

## 商品圖片（ADR 0003）

新增商品預設下架；先在編輯頁上傳商品圖片，才可在商品管理「重新上架」。管理員選擇 JPEG／PNG／WebP（原檔上限 20 MiB），瀏覽器產生 320／640／1280px 寬的 WebP，每個尺寸最多 2 MiB；原圖不傳送、不保存。App 驗證 Access JWT、WebP 檔案尺寸與大小後，先寫 R2，再寫 D1。每件商品最多 8 張，第一張為封面。瀏覽器對同一次選檔保留 uploadId；上傳已提交但回應遺失時，重試會回傳原圖片，不重複佔用名額。

App 與 Web 都綁定 `PRODUCT_IMAGES`，Web 只呼叫 `get`。物件 key 為 `products/<商品編號>/<圖片 UUID>/<內容 SHA-256>.webp`，同一張圖片的物件有獨立所有權，失敗回滾不會刪到其他上傳的物件。公開 `/images/...` 回應一年 immutable cache；下架後已知網址仍可讀圖。

部署前必須在同一 Cloudflare 帳戶建立 Standard R2 buckets：

- preview：`storefront-product-images-preview`
- production：`storefront-product-images-production`

本機的 `storefront-product-images-local` 由 Wrangler／Miniflare 模擬，不需要遠端 bucket。部署流程在任何 migration 前以唯讀 `wrangler r2 bucket info` 驗證該環境的 bucket 存在，缺少時先中止。設定檔不代表遠端 bucket 已建立；R2 使用可能產生 Cloudflare 費用，需先確認部署帳戶與費用授權。

Migration `0007_product_images.sql` 會新增圖片表、把商品 `listed` 預設改為 false，並把目前無商品圖片的既有商品全部下架；商品編號、庫存與既有訂單明細都保留。更新後須由管理員上傳圖片並重新上架，不會自動補圖。部署順序沿用先 migration、再 App、再 Web；遷移與 App 更新之間不要執行舊管理員新增／上架操作，舊 App 尚未具備圖片 invariant。若回滾程式，不能回滾到允許無圖上架的舊 App 而繼續營運，應保持新版 App 或先停止商品管理操作。

### 圖庫管理

後台可一次選取多張圖片，依序上傳（每件商品最多 8 張）。部分上傳失敗時，已完成的圖片保留；重試只處理剩餘選檔，沿用每張圖片的 uploadId。商品圖片可拖曳或以「上移」「下移」按鈕排序，第一張立即成為封面；後台清單也顯示封面。

排序 RPC 必須提交完整、不重複的商品圖片 ID 清單，與 D1 現況不一致即拒絕。Migration `0008_careful_blonde_phantom.sql` 保留現有圖片、key 與 uploadId，將順位索引改為非唯一索引：SQLite 的逐列唯一性檢查無法交換已滿 8 張的順位。所有順位寫入透過原子 SQL／D1 batch 保持唯一且連續，排序驗證與更新在同一交易內。

刪除先以同一 D1 batch 檢查「上架中至少一張」、寫入清理佇列、移除引用並緊縮順位，提交後才刪除 R2 物件，避免留下破圖封面。失敗回應會重新載入後台圖庫，保留未完成的上傳。R2 失敗或提交回應遺失可重試；既有每分鐘 Cron 每次重試最多 20 筆清理，失敗項目依最近嘗試時間輪替，避免阻塞其他圖片。商品下架後可刪至 0 張。已下載或快取的公開圖片不會因來源物件刪除而撤回。

### 商品變體（預設變體）

依 [ADR 0005](docs/adr/0005-variants-own-price-and-stock.md)，可購買、定價與計算庫存的單位是商品變體（`product_variants`）。目前每個商品只有一個預設變體，由 Migration `0013_product_variants.sql` 從既有商品的售價、原價與在庫數轉成；新增商品時一併建立。商品保留名稱、說明、分類、圖片與上架狀態，不再有 `price_twd`、`compare_at_price_twd`、`on_hand`。多變體與選項維度由後續票擴充。

- 購物車、結帳與庫存調整都以變體編號為準：結帳明細帶 `variantId`，訂單明細同時記 `variant_id` 與 `product_id`（取封面、連結），後台庫存調整送 `variantId`。商品詳情與列表帶 `defaultVariantId` 供加入購物車。被取代的以商品編號結帳的路徑已移除，瀏覽器購物車格式升到第 2 版，舊版購物車會被視為空（顧客需重新加入）。
- 沿用現行付款扣庫語意：保留 = 待付款訂單明細（以變體加總），付款成功才扣在庫數；逾期、取消與遲到付款的規則不變。
- 遷移保留歷史：舊明細逐筆指向該商品的預設變體，單價、數量、名稱快照與訂單總額原樣不動，所以實付金額與免運結果不變；對不到預設變體的明細會讓 `variant_id NOT NULL` 失敗、整個遷移中止，不會丟掉明細或編造對應。
- 部署順序沿用先 migration、再 App、再 Web，窗口內的影響：(1) migration 後、新 App 前，舊 App 的商品列表、結帳與付款事件 SQL 會因 `products.price_twd`／`on_hand` 不存在而失敗，這段時間顧客無法瀏覽與結帳，付款事件套用也會失敗；(2) 新 App 上線、新 Web 未上線時，舊 Web 以 `productId` 結帳、以 `{ id }` 調庫存，會被驗證擋下回 `invalid_input`（不會寫入）。建議把兩個窗口壓到最短，並在 migration 前暫停後台庫存與商品操作。
- 窗口內付款事件的補救：付款事件套用失敗時，付款與訂單都不會被改動。依據是閘道的事件本文在建立時固定、投遞紀錄存檔，且 `apps/gateway/src/transitions.ts` 註明可由閘道主控頁重送，程式內沒有自動重試；顧客被導回 `/orders/:id/payment-return` 時 App 也會主動向閘道查詢一次。補救順序：新 Web／App 都上線後，先到閘道主控頁查看窗口期間各事件的投遞結果，對失敗的事件重送（套用以事件 ID 去重，重送安全）；若主控頁查不到該事件或重送仍失敗，再人工以該事件的內容重放 webhook，並對照訂單與付款狀態確認。人工重放的步驟與權限尚無既有文件，需事前另行確認。
- 回復：套用後若要退回，先停止寫入，再執行 `wrangler d1 execute <DB> --file apps/app/rollback/0013_product_variants.down.sql`（加 `--local`／`--remote`／`--env`）；它把預設變體寫回 `products`、明細改回只指向商品、移除 `d1_migrations` 紀錄。只在每個商品都恰好一個預設變體時可用，否則守門檢查會讓回復失敗。回復前須一併回復 Web、App 與 E2E 呼叫端（購物車格式與結帳輸入都已變更）。測試見 `apps/app/test/product-variants-migration.test.ts`。
