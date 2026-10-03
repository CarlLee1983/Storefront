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

## 聯絡 email 與模擬信箱

顧客在帳戶頁（`/account`）驗證或更換聯絡 email，並在自己的模擬信箱（`/account/mailbox`）讀驗證信。聯絡 email 與登入身分各自獨立：LINE 與 Google 不合併，登入識別 email（含 LINE 的 placeholder）不會被當作已驗證的聯絡資料。首次結帳前須有已驗證的聯絡 email：結帳 RPC 回 `contact_email_unverified`，`/checkout` 會導去 `/account?reason=checkout`（購物車在瀏覽器，不受影響）。資料在 Migration `0016_contact_mailbox.sql`（`contact_verifications`、`mail_messages`、`mail_deliveries`、`mail_controls`）。

- 顧客 RPC（皆以 cookie 驗身分，查詢一律限定該顧客）：`getMyContact`、`requestContactEmail`、`verifyContactEmail`、`listMyMail`、`getMyMail`。管理 RPC（需 Access JWT）：`listMailForAdmin`、`resendMail`、`setMailDeliveryFailure`；後台頁面是 `/admin/mail`。
- 驗證：送出新地址會取代前一筆未完成的請求，驗證連結 24 小時內有效，同一顧客 10 分鐘內最多 5 筆請求（超過回 `too_many_requests`）；新地址驗證成功才成為通知收件地址，在此之前既有已驗證地址不變。驗證連結要登入收信的那位顧客後開啟並按「確認驗證」（連結本身不變更資料），別人的憑證與不存在的憑證同樣回 `invalid_token`。
- 信件內容不可變，每次投遞（含重送）記錄實際收件地址，換址不改寫歷史。只有送達的信會出現在顧客信箱；管理員看得到每次投遞的結果與收件地址，但看不到內文與驗證憑證。重送是同一封信的新投遞：驗證信只有在它的驗證請求仍有效時可重送（寄到它要驗證的地址），其他種類的信寄到顧客目前已驗證的地址。
- 演練控制：管理員可開啟「投遞失敗」，之後每次投遞（含重送）都失敗，直到關閉；狀態存在 `mail_controls`（沒有這一列等於正常）。新增通知種類只需在 `apps/app/src/contact/mail.ts` 的 `MAIL_KINDS` 加值並寫入 `mail_messages`／`mail_deliveries`，資料表不需改動。
- 部署順序沿用先 migration、再 App、再 Web。0016 只新增資料表，舊 App 與舊 Web 不受影響；但新 App 搭配舊 Web 時，舊結帳頁遇到 `contact_email_unverified` 只會顯示通用的結帳失敗訊息，應壓短窗口。上線後尚未驗證聯絡 email 的既有顧客（含已有訂單者）下次結帳前都須先驗證。
- 回復：先停止寫入，再執行 `wrangler d1 execute <DB> --file apps/app/rollback/0016_contact_mailbox.down.sql`；已有驗證請求、信件或投遞紀錄時守門檢查讓回復失敗（顧客已驗證的聯絡 email 會隨之消失），須先確認這些資料可以捨棄。回復前須一併回復會呼叫這些 RPC 的 Web 與 App，以及 E2E 的會員種子資料。測試見 `apps/app/test/contact-email.test.ts`、`admin-mail.test.ts`、`checkout-contact.test.ts`、`contact-mailbox-migration.test.ts`；手機與桌機的操作（含顧客隔離與管理員控制）由 `e2e/tests/contact-mailbox.spec.ts` 驗證（375／1280 寬，含無障礙掃描）。E2E 與測試用的會員需自行安排一筆已驗證的聯絡 email 才能結帳（`e2e/harness/serve.ts` 的種子會員已含；`apps/app/test/customers.ts` 的 `signInCustomer` 預設寫入）。
- 交易通知（Migration `0018_transaction_notifications.sql`，沿用上述信箱與投遞紀錄）：下單寄 `order_placed`；付款有結果寄 `payment_succeeded`、`payment_failed`，或付款到得太晚而無法使訂單成立時寄 `payment_unsettled`。信件本體採 outbox：與業務變化寫在同一個 batch（下單的 `placeOrderIfAvailable`、付款的 `applyPaymentEvent`），訂單或付款結果成立，信就一定存在；`mail_messages.event_key`（`order_placed:<訂單>`、`payment:<付款>`，唯一索引）讓冪等重送、webhook 重送與導回查詢重複套用都不產生第二封。首次投遞在交易之外：收件地址是當下已驗證的聯絡 email；投遞階段的任何例外只記 log，不影響下單或付款，缺投遞的信在管理端待處理，並在同一冪等鍵的結帳重送或同一付款事件的重送時自動補上首次投遞。顧客沒有已驗證地址時只有信件沒有投遞，驗證後可重送。
- 待辦與處理紀錄：`/admin/mail` 把「還沒有任何一次送達、且還能處理」的信標為「待處理」（被取代或過期的驗證信不算），超過最新 200 封的舊待辦仍會列出（最多再列 500 封，更舊的只顯示「另有 N 封」）；管理員重送會在新的投遞上記下處理人（`mail_deliveries.handled_by`，系統首次投遞為空）。
- 0018 只新增兩個可為空的欄位與一個唯一索引，部署順序同樣先 migration、再 App、再 Web；新 App 的下單與付款 batch 會寫 `event_key`，0018 缺欄位時下單與付款會整批失敗，所以 migration 必須先套用。回復：先停止寫入，再執行 `apps/app/rollback/0018_transaction_notifications.down.sql`（已有交易通知或處理紀錄時守門檢查讓回復失敗，須先確認這些資料可以捨棄）；回復順序是 0018 → 0017 → 0016，且回復前須一併回復會呼叫這些 RPC 的 Web 與 App。測試見 `apps/app/test/order-notifications.test.ts`、`transaction-migration.test.ts`；手機與桌機的操作併在 `e2e/tests/contact-mailbox.spec.ts`（投遞失敗演練是全域狀態，會開關它的情境必須留在同一檔序列執行）。
- 出貨通知（#112）：每個出貨批次寫一封 `shipment_dispatched`（商品數量、物流單號、議定時段），見下方「分批出貨與大型配送預約」。
- 退款成功通知（#115）：每筆成功的退款寄一封 `refund_succeeded`（事件鍵 `refund:<退款編號>`），與退款轉為成功同一個 batch 寫入；重試與重複回呼不重複。
- 取消審核（#116）與退貨審核、檢查完成（#117）通知：`cancellation_approved`／`cancellation_rejected`、`return_approved`／`return_rejected`／`return_completed`（一案一封，事件鍵 `return:<申請編號>:<approved|rejected|completed>`），都與該決定同一個 batch 寫入；檢查完成的信依退款是否已登記分文案。
- 發票開立通知（#121）：每張已開立的模擬發票寄一封 `invoice_issued`（事件鍵 `invoice:<發票編號>`），與開立同一個 batch 寫入，見下方「模擬發票（#121）」。
- 折讓完成通知（#122）：每筆已折讓的退款寄一封 `allowance_issued`（事件鍵 `allowance:<退款編號>`），與折讓同一個 batch 寫入，見下方「模擬發票折讓（#122）」。
- 尚未涵蓋（後續票）：其餘進度與時間線等通知。

## 地址簿

顧客在 `/account/addresses` 保存、修改、刪除自己的收件資訊（姓名、電話、地址，欄位規則同結帳；每人上限 10 筆），結帳頁（`/checkout`）的「使用地址簿」下拉選單把選中的內容帶入收件欄位，送出前仍可修改。訂單的收件資訊是送出當下表單內容的快照（`orders.shipping_*`），不引用地址簿，之後修改或刪除地址都不影響既有訂單。地址簿 RPC（`listMyAddresses`、`addAddress`、`updateAddress`、`deleteAddress`）一律由 cookie 換顧客身分並以該顧客為條件，別人的地址編號與不存在的編號同樣回 `address_not_found`；未登入回 `unauthorized`。資料在 Migration `0017_address_book.sql`（`customer_addresses`），只新增資料表，部署順序沿用先 migration、再 App、再 Web，舊 App 與舊 Web 不受影響。

- 回復：先停止寫入，再執行 `wrangler d1 execute <DB> --file apps/app/rollback/0017_address_book.down.sql`；表內已有地址時守門檢查讓回復失敗（顧客保存的地址會消失，訂單上的快照不受影響），須先確認可以捨棄。回復前須一併回復呼叫這些 RPC 的 Web 與 App。
- 測試見 `apps/app/test/address-book.test.ts`、`address-book-migration.test.ts`；手機與桌機的操作（含顧客隔離、結帳選用與舊單不變）由 `e2e/tests/address-book.spec.ts` 驗證（375／1280 寬，含無障礙掃描）。

## 配送類型與運費

台灣本島限定，兩種配送類型：一般宅配與大型配送（`apps/app/src/shipping/types.ts` 的 `DELIVERY_TYPES`）。配送類型設在商品變體（`product_variants.delivery_type`，預設一般宅配）：沒有選項的商品在商品編輯頁的主表單設定，有選項的商品在「選項與變體」的各變體卡片設定；新增商品與新增變體也可指定。費率在 `/admin/shipping`（RPC `getShippingRates`、`setShippingRate`，需 Access JWT），初始演練值一般 NT$100、大型 NT$600，可調為 0（該類型免運）。

- 計費：一張訂單裡含某類型的變體就收該類型費率一次，混合兩類各收一次，同類不按件數或明細數加收；商家日後分批出貨不追加。總額 `orders.total_twd` = 商品小計 + 兩類運費，付款金額與下單通知信件都用它，三者一致。
- 快照：訂單把成立當下各類實收運費寫進 `orders.standard_shipping_fee_twd`、`large_shipping_fee_twd`（沒有該類型為 0），明細把配送類型寫進 `order_lines.delivery_type`，連同商品名、選項、實付單價與收件資訊都不隨之後的改價、改費率或改類型而變。#112（分批出貨）、#115（異常退款）、#116（部分取消退運費，見「部分取消」）從這幾個欄位讀取。
- 顧客確認：購物車只在瀏覽器，結帳頁向 `GET /api/shipping-quote?variants=…`（App 的公開 RPC `getShippingQuote`）取得現行費率與各變體的配送類型，列出兩類運費與總額、說明限台灣本島並要求勾選確認；送出時帶 `seenShippingTwd`（顧客確認的運費合計），App 在下單 batch 內以當下的費率與類型重算並比對，不符就整批不成立並回 `shipping_fee_changed`（與價格變動同樣由重新載入的結帳頁讓顧客再確認）。查不到運費時結帳頁停用送出鈕。
- 下單 batch 的語句數與順序不變（#109 的通知信仍是第 4 句）：運費由訂單本體那句用 `json_each` 子查詢算出並寫入，明細那句的 WHERE 加上「運費合計 = 顧客確認的金額」；兩句在同一個 batch 讀同一份資料。冪等鍵的內容指紋含 `seenShippingTwd`。
- 舊單：Migration `0019_shipping_fees.sql` 對既有訂單的兩個運費欄位預設 0、明細預設一般宅配，所以歷史訂單的總額與免運結果不變；寫入初始費率兩列。新增欄位未加 CHECK（drizzle-kit 的 `check()` 是表層級約束，產生的遷移會重建資料表），合法值由管理 RPC 的輸入驗證限定；`shipping_rates` 有 CHECK。
- 部署順序沿用先 migration、再 App、再 Web。舊 App 搭配新 migration 仍可運作（欄位都有預設），但新 App 的結帳要求 `seenShippingTwd`，所以舊 Web 的結帳頁在新 App 上會被拒（回 `invalid_input`），Web 與 App 應壓短窗口一起部署。回復：先停止寫入，再執行 `wrangler d1 execute <DB> --file apps/app/rollback/0019_shipping_fees.down.sql`；已有訂單收過運費、或有大型配送的變體／明細時守門檢查讓回復失敗（總額含運費卻會失去拆分），須先確認可以捨棄。回復前須一併回復 Web 與 App；順序是 0019 → 0018 → …。
- 測試見 `apps/app/test/shipping-fees.test.ts`（計費、快照、金額一致、權限、輸入驗證）、`shipping-migration.test.ts`；Web 的試算與表單轉換在 `apps/web/src/checkout/shipping.test.ts`；手機與桌機操作由 `e2e/tests/shipping-fees.spec.ts`（混合結帳與後台）與 `shipping-rates.spec.ts`（調整費率不改舊單、非管理員 403；費率是全域狀態，獨立成最後執行的 project）驗證。

## 庫存保留與庫存流水

依 [ADR 0006](docs/adr/0006-physical-stock-deducted-on-dispatch.md)：可售 = 在庫數 − 不可售 − 待付款保留 − 已付款待出貨保留（不可售是在庫中待檢與損壞的退貨，由 #117 加入、另列不是另一份庫存，物流退回入倉（#120）沿用；`product_variants.unavailable`，算式只在 `apps/app/src/catalog/stock.ts`），保留由訂單狀態推導（待付款、已付款與部分出貨訂單中「尚未交運」的明細數量，即明細數量減各批已交運數量與已核准取消的數量，沒有另外的保留表）。

| 事件 | 在庫數 | 保留 | 可售 |
| --- | --- | --- | --- |
| 下單 | 不變 | + 待付款保留 | − |
| 付款成功（含遲到付款重新保留，ADR 0001） | 不變 | 待付款轉已付款，總量不變 | 不變 |
| 逾期、取消 | 不變 | 釋放 | + |
| 交運一批（`shipOrder`） | − 該批數量 | 消耗該批的已付款保留 | 不變 |
| 庫存調整 | ± | 不變 | ± |
| 退貨實際收回（`recordReturnReceipt`） | + 收到數量（另增不可售） | 不變 | 不變 |
| 退貨檢查合格（`recordReturnInspection`） | 不變 | 不變 | + 良品數量（不可售轉可售）；損壞品留在不可售 |
| 損壞品報廢（`scrapUnavailableStock`） | − 報廢數量（同減不可售） | 不變 | 不變 |

- 付款 batch（`payments/queries.ts` 的 `applyPaymentEvent`）不再扣庫，原本的第 3 句（扣在庫數）已移除，結果索引由尾端倒數取值所以不受影響；交運（`shipments/dispatch.ts` 的 `dispatchShipment`）每批一個 batch：建立批次、寫批次明細、扣在庫、寫流水、轉訂單狀態、寫出貨通知，細節見下一節。
- 庫存流水（`stock_movements`，Migration `0020_stock_ledger.sql`）：在庫數的每一次變動，只增不改不刪，記來源（`adjustment` 調整、`dispatch` 交運、`migration` 遷移加回，#117 起另有 `return_received` 退貨收回入倉、`return_inspected` 檢查合格轉可售、`scrap` 報廢）、在庫增減量與調整後在庫數、不可售增減量與調整後不可售（#117 的 `unavailable_delta`、`unavailable_after`，舊流水為 0）、訂單、操作人（管理員 email）、原因與有效時間。流水與改動在庫數的那句同一個 batch、同一個條件寫入，被拒絕的調整不留紀錄。保留的變化（下單、付款、逾期、取消）可由訂單推導，不重複寫入流水。後續票（#124 低庫存提醒）讀這張表，新增來源時加新的 `kind`；`kind` 沒有 CHECK，合法值由寫入端限定。
- 庫存調整現在必填原因（`adjustStock` 的 `reason`，trim 後 1–200 字）；後台商品列表與變體表單都有原因欄位。唯讀 RPC `listStockMovements`（可依變體或訂單篩選，以 `nextBeforeId` 游標翻頁）與後台「庫存流水」頁（`/admin/stock-movements`，訂單明細頁有連結）供核對。
- 舊資料遷移（Q22 保留式遷移）：舊系統在付款時就扣了在庫數，`0020` 對每張狀態為「已付款」的舊單，逐單逐變體把數量加回在庫數並寫一筆 `migration` 流水；已出貨的不加回；因為已付款本身就是保留，可售量不變。遷移只信訂單狀態、不編造物流證據。套用後執行 `wrangler d1 execute <DB> --file apps/app/scripts/verify-0020-stock.sql`（加 `--local`／`--remote`／`--env`）核對例外，每個查詢回傳的列都需要人工處理，全為空才算通過：已付款卻沒有成功付款紀錄、可售為負、流水與在庫數對不上。
- 部署順序：**先停止寫入（結帳、付款、出貨、庫存調整）**，再 migration、再 App、再 Web。舊 App 搭配新 migration 會多出可售量（舊 App 不把已付款算進保留，加回的數量變成可售）；新 App 搭配舊資料則會在出貨時再扣一次，所以兩者之間不要放行流量。
- 回復：先停止寫入並先回復 App，再執行 `wrangler d1 execute <DB> --file apps/app/rollback/0020_stock_ledger.down.sql`。它把目前每張已付款訂單的數量從在庫數扣回（回到付款扣庫語意，涵蓋遷移前的舊單與遷移後才付款的新單），移除流水與遷移紀錄。守門檢查讓回復失敗的情況：流水裡有遷移以外的紀錄（調整與交運紀錄一旦移除就無法稽核），或扣回後在庫數會小於 0；須先確認這些資料可以捨棄或人工處理。回復順序是 0020 → 0019 → …。
- 測試見 `apps/app/test/stock-ledger.test.ts`（付款不扣庫、交運扣庫與流水、重複與並行出貨、已付款保留擋住調整、原因必填、查詢與權限）、`stock-ledger-migration.test.ts`（遷移、核對腳本、回復與守門檢查），遲到付款與逾期釋放沿用 `payment-late-success.test.ts`、`expiry.test.ts`；Web 的篩選解析在 `apps/web/src/admin/stock-form.test.ts`，手機與桌機的操作（含顧客不能進入）由 `e2e/tests/stock-ledger.spec.ts` 驗證（375／1280 寬，含無障礙掃描）。

## 分批出貨與大型配送預約

依 [ADR 0006](docs/adr/0006-physical-stock-deducted-on-dispatch.md)，管理員按明細數量交運多個**出貨批次**（Migration `0021_shipments.sql`；`apps/app/src/shipments/`）。

- 資料：`shipments`（訂單、冪等鍵 `dispatch_key`、物流單號、議定時段 `appointment_start`／`appointment_end`、交運時間、操作人，只增不改）與 `shipment_items`（批次明細：訂單明細、數量）。配送進度與送達時間由 0022 加在批次上（見下一節），#116（部分取消）、#118（依各批送達日退貨）同樣以批次為單位延伸；配送類型取自明細快照（`order_lines.delivery_type`），不在批次上重複。`orders.tracking_number`、`shipped_at` 已移除，一律讀批次。庫存流水新增 `shipment_id`（每批交運的流水指向該批；0021 之前的舊流水為空）。
- 訂單狀態新增「部分出貨」（`partially_shipped`）：至少交運過一批、仍有明細未出完；每筆明細都出完才轉「已出貨」。轉換表見 `orders/transitions.ts`。未交運的數量仍是已付款保留（`catalog/stock.ts`），所以交運只減在庫與保留各一次，可售數量不變；並行的庫存調整不能把可售壓到負數。
- 交運（`shipOrder`，輸入 `orderId`、`dispatchKey`、`items: [{ orderLineId, quantity }]`、選填 `trackingNumber`、`appointment: { start, end }`）是單一 batch：建立批次的條件是訂單此刻為已付款或部分出貨、同一冪等鍵還沒有批次、且每筆明細「已交運＋本批」不超過明細數量；其後的批次明細、扣在庫、流水、狀態轉換、出貨通知都只在批次存在且還沒扣過庫時執行。並行的兩次交運，先落地者贏，後者回 `shipment_quantity_exceeded`（或訂單已出完時 `order_not_shippable`）；同一冪等鍵重送回原批次（`replayed: true`；內容與原批次不同回 `dispatch_key_conflict`，比對 `shipments.request_hash`），不重複扣庫、不寫第二筆流水、不寄第二封信。取消申請（#116）與交運競爭同一數量：交運的條件另外扣掉被取消申請占用（待審與核准）的數量，以 batch 落地順序為準（見「部分取消」）。
- 大型配送：批次含大型配送明細時必填議定時段（`appointment_required`），只含一般宅配時不可填（`appointment_not_applicable`）；時段只是記錄（UTC epoch 毫秒，網頁表單以台北時間輸入），不做司機容量排程。分批不追加運費，`orders.total_twd` 與兩類運費快照不變。
- 舊資料：0021 為每張舊的已出貨訂單補一批整單批次（`dispatch_key = 'legacy:0021'`，輸入驗證產生不出這個鍵、且內容指紋 `request_hash` 為空，所以重送交運永遠不會對舊批次再扣庫或寄信），物流單號與出貨時間照搬舊欄位，舊單沒有的出貨時間、預約留空，不編造；那些訂單在 0020 之前就已扣庫，補建批次不動庫存也不寫流水。orders 為了放寬狀態 CHECK 與移除舊欄位而重建（D1 不能關外鍵，改用備份、砍表、建表、寫回，並還原 AUTOINCREMENT 計數）。
- 通知：每批在同一個 batch 寫一封 `shipment_dispatched`（`event_key = shipment:<批次編號>`），交運後立即投遞，投遞失敗不影響交運，出現在 `/admin/mail` 待處理，重送同一批時補首次投遞。
- 畫面：管理員訂單頁「交運一批」表單（每筆未交運明細一個數量欄，預設為全部未交運數量；物流單號；大型配送議定時段）與「出貨批次」清單；顧客訂單頁與我的訂單列出各批的商品數量、物流單號與議定時段。
- 部署順序：先停止寫入（交運），再 migration、再 App、再 Web；舊 App 不認得 `partially_shipped` 與批次。回復：先停止寫入並先回復 App，再執行 `wrangler d1 execute <DB> --file apps/app/rollback/0021_shipments.down.sql`（會把整單批次搬回舊欄位；有部分出貨的訂單或遷移之後才建立的批次時守門檢查讓回復失敗，須先確認這些資料可以捨棄）。回復順序是 0021 → 0020 → …。
- 測試見 `apps/app/test/admin-ship.test.ts`（整批與分批交運、超量、冪等重送、並行、預約、通知、可見範圍與權限）、`shipments-migration.test.ts`（補建舊批次、重建 orders、回復與守門檢查）；Web 的表單解析在 `apps/web/src/admin/order-form.test.ts`，手機與桌機的操作由 `e2e/tests/shipments.spec.ts` 驗證（375／1280 寬，含無障礙掃描）。

## 追蹤送達與失敗後再次配送

每批各自追蹤配送進度（Migration `0022_shipment_delivery.sql`；`apps/app/src/shipments/events.ts`）。物流是模擬服務：管理員在訂單頁的批次清單「記錄物流回報」（RPC `recordShipmentEvent`，輸入 `shipmentId`、物流給的事件識別 `eventKey`、種類 `delivered`／`delivery_failed`／`redelivery`、發生時間 `occurredAt`）。

- 資料：`shipment_events`（只增不改的對帳紀錄，同一批同一 `event_key` 只有一筆；發生時間 `occurred_at` 與系統記錄時間 `recorded_at` 分開存）；`shipments.delivery_status`（`in_transit`／`delivery_failed`／`delivered`／`lost`（#119，見「確認物流遺失」）／`returned`（#120，見「物流退回入倉檢查後退款」），預設 `in_transit`）與 `shipments.delivered_at`（實際送達時間，逐批記錄，#118 依各批送達日讀它）。進度不接受直接寫入，每次記錄回報都由該批全部事件重新推導，不看到達順序：有送達回報就是已送達（終點），送達時間取發生最早的一筆；否則依發生時間最新的回報，配送失敗 → `delivery_failed`，再次配送或沒有回報 → `in_transit`。所以延遲、重送、亂序都不會偽造送達或打回已確定的進度；已送達後才到的失敗或再次配送回報只留紀錄。
- 再次配送是同一批原貨再交付：不建新批次、不新增出貨數量、不扣庫、不退款（暫時失敗後送達無退款，設計文件 Q25），也因此不碰 `request_hash` 不變式。確認遺失見下面「確認物流遺失」（#119），物流退回與入倉檢查見「物流退回入倉檢查後退款」（#120）。
- 驗證：發生時間須不早於該批交運時間（有的話）、不晚於現在，否則 `event_time_invalid`；批次不存在 `shipment_not_found`；同一事件鍵帶不同內容 `event_key_conflict`。同鍵同內容重送回 `replayed: true`。舊批次（0021 補建）沒有可靠送達日，維持運送中、`delivered_at` 為空，不編造。
- 通知（沿用 #109 outbox，與回報同一個 batch 寫入）：送達通知 `shipment_delivered`（一批一封，`event_key = shipment_delivered:<批次編號>`；信件記載寫信當下的送達時間，之後才到的較早送達回報會更新 `delivered_at`，但不改寫已寄出的信）、配送異常通知 `shipment_delivery_failed`（一次失敗回報一封，`event_key = shipment_delivery_failed:<批次編號>:<回報事件鍵>`；只在該批未送達、且它是發生時間最新的回報時才寄，已送達後才到或已被後續回報取代的失敗回報不寄）；再次配送不寄信。投遞失敗不影響記錄，出現在 `/admin/mail` 待處理，可重送。
- 查證與補齊：管理員訂單頁每批的「物流回報」列出事件與其通知是否存在：`noticeExpected`（與寫信同一條件）為真而 `noticeMessageId` 為空才標「通知缺漏」，不該寄的（再次配送、已被取代或已送達）顯示「不寄信」；通知遺失時按「補齊通知」以同一事件重送，補回信件且不產生第二封。顧客訂單頁與我的訂單顯示各批配送進度與實際送達時間（顧客路徑不查物流回報）。表單回報時間精度到秒。
- 回復：先回復 App，再執行 `wrangler d1 execute <DB> --file apps/app/rollback/0022_shipment_delivery.down.sql`（已有任何物流回報或已送達批次時守門檢查讓回復失敗，須先確認可以捨棄）。回復順序是 0022 → 0021 → …。
- 測試見 `apps/app/test/shipment-delivery.test.ts`（送達、失敗後再次配送、亂序／重送／通知遺失、時間與衝突、權限）、`shipment-delivery-migration.test.ts`；Web 表單解析在 `order-form.test.ts`，手機與桌機操作由 `e2e/tests/shipment-delivery.spec.ts` 驗證。

## 付款

顧客在訂單頁按「前往付款」→ App 向閘道建立付款 → 導向閘道付款頁；結果由兩條路徑確認，共用同一個冪等的「套用付款結果」（以閘道事件 ID 去重）：閘道 webhook（Web 的 `POST /api/payments/webhook`，驗簽後轉給 App）為主，顧客被導回 `/orders/:id/payment-return?paymentId=…` 時 App 再主動向閘道查詢一次。付款成功依訂單當下的狀態分流（都只由搶到事件 ID 的那次呼叫執行一次）：待付款轉已付款；已逾期則在同一個 batch 內以條件式語句「重新保留」庫存（每一筆明細的可售數量都夠才轉為已付款（轉為已付款保留，不動在庫數），全有全無），見 ADR 0001；重新保留不到、落在已取消的訂單、或同一張訂單的第二筆成功付款，則付款記為成功、訂單不動，並登記一筆整筆退款（見下方「退款」）。付款狀態不再有 `refunded`／`refund_failed`：退款不改付款狀態。

付款的失效時間取「發起後 10 分鐘」與「付款期限前 2 分鐘」較早者，付款期限前 2 分鐘內不能再發起付款（`payment_window_closed`，ADR 0001 第一道防線）；閘道回的失效時間不早於付款期限視為回應不合法。訂單以 `orders.paid_by_payment_id` 記錄由哪一筆付款支付；後台訂單清單與明細對「付款成功卻沒有退款紀錄、訂單不是由它支付」或「有退款尚未成功」的付款標示「需要處理」。

顧客取消待付款訂單時，先讓進行中的付款全部失效（向閘道取消；回 409 就查詢並套用閘道結果，其實已成功則訂單轉已付款、取消被拒），閘道連不上則不取消訂單。

### 漏通知後補查與復原

顧客付款後關窗、webhook 也沒送到時，不能只靠顧客返回頁面（設計文件 A9；Migration `0023_payment_reconcile.sql`；`apps/app/src/payments/reconcile.ts`、`service.ts` 的 `reconcileOne`）。補查對本地仍是 `pending` 的付款向閘道查詢，終局結果（成功／失敗，帶事件 ID）一律交給同一個 `applyEvent`（與 webhook、導回查詢同一條路徑與事件 ID 去重），不另寫第二條套用路徑，所以重複補查、補查與 webhook 先後順序改變都不會重複入帳或重複保留；遲到的成功仍依 ADR 0001 重新保留或退款，付款結果通知與付款同一個 batch 寫入。

- 觸發：每分鐘 Cron（`scheduled`）在逾期處理之前先補查本地 pending 的付款：建立超過 5 分鐘（`RECONCILE_GRACE_MS`），或已過閘道失效時間（付款期限前 2 分鐘內才發起的付款失效時間離建立不到 5 分鐘，仍要在訂單逾期前查到結果）。一次最多 20 筆（`RECONCILE_BATCH_SIZE`），依 `payments.reconciled_at`（每次補查開始前就記，不論結果）最久沒查的在前、其中失效時間較早的先查，所以一直查不出結果的付款不會擠掉其他付款。每次呼叫閘道最久等 5 秒（`GATEWAY_TIMEOUT_MS`，逾時視為 `unreachable`），整個補查最多花 20 秒（`RECONCILE_BUDGET_MS`），超過就不再開始新的一筆；補查出錯只記 log，不擋逾期與圖片清理。管理員也可在 `/admin/payments`（導覽「付款補查」）對任一筆 pending 付款按「補查」（RPC `reconcilePayment`，輸入 `paymentId`；清單 RPC `listPaymentsToReconcile`）。付款設定不全時回 `payment_unavailable`，Cron 只記一行 log。
- Cron 的子請求量（估算，未對照 Cloudflare 官方上限逐項確認）：一次 Cron 最多補查 20 筆，每筆 1 次閘道 fetch；其中成功且需退款的另加 1 次退款 fetch（退款首次送出；之後的查證與重試只由管理員觸發），所以閘道 fetch 最多約 40 次；D1 與其他呼叫不計入這裡的估算。Free 方案每次呼叫的子請求上限是 50，仍在範圍內，但若之後調高批量要重新估算。
- 查證：閘道回的付款 ID、金額與商家參照必須與本站記錄一致；連不上（含逾時）、回錯、格式不符、付款 ID／金額／參照不符、成功或失敗卻沒有事件 ID，都不套用也不偽造成功。閘道說已失效 → 本地付款轉 `expired`；說仍在等待 → 不動、不算問題。
- 待辦：沒能確認結果時，每筆付款一列寫進 `payment_reconcile_issues`（原因 `gateway_unavailable`／`gateway_mismatch`／`result_unclear`、失敗次數、第一次與最近一次時間、最近一次的觸發者 `cron` 或管理員 email）並記 `payment_reconcile_issue` log。待辦是否開著只看 `resolved_at` 是否為空（後台清單與回復守門同一定義）：付款離開 pending 時，套用的路徑（`applyPaymentEvent` 的 batch、`expirePayment`）一併記為已解決，閘道說仍在等待則由補查解決；已解決的列保留供追溯，再出問題時重新計次。`/admin/payments` 把有待辦的付款排最前面，顯示原因、次數、時間與建議處理。
- 已知限制：`gateway_mismatch`（閘道回的資料與本站記錄對不上）與 `result_unclear` 是資料面的矛盾，後台只能重新補查，沒有「接受閘道結果」或「作廢」的操作；需要工程人員到閘道主控頁核對後處理。
- 與 #115：異常退款的逐筆紀錄與安全重試另建自己的退款表，不延伸 `payment_reconcile_issues`（見下方「退款」）。
- 回復：先回復 App 與 Web，再執行 `wrangler d1 execute <DB> --file apps/app/rollback/0023_payment_reconcile.down.sql`（移除待辦表與 `payments.reconciled_at`；還有開著的待辦時守門檢查讓回復失敗，須先處理或確認可以捨棄）。
- 測試見 `apps/app/test/payment-reconcile.test.ts`（管理員補查、冪等與先後順序、遲到付款、待辦、權限、Cron）、`payment-reconcile-migration.test.ts`；Web 提示文字在 `apps/web/src/admin/payment-reconcile.test.ts`，手機與桌機操作（含閘道延遲回呼加關窗、補查後顧客進度與通知一致、顧客不能進補查頁）由 `e2e/tests/payment-reconcile.spec.ts` 驗證。

設定（缺少時只有付款不可用，其餘頁面照常；部署前檢查同上，見 `apps/app/scripts/check-auth-deploy.ts`）：

- App：`GATEWAY_BASE_URL`（`apps/app/wrangler.jsonc` 各環境的 vars，閘道 Worker 的網址）與 secret `GATEWAY_API_KEY`（= 閘道的 `GATEWAY_API_KEY`）。閘道導回與 webhook 的網址由 `BETTER_AUTH_URL`（Web 的公開 origin）組成。缺少時 `startPayment`、`confirmPayment`、`reconcilePayment` 回 `payment_unavailable`。
- Web：secret `GATEWAY_WEBHOOK_SECRET`（= 閘道的 `GATEWAY_WEBHOOK_SECRET`），於 `apps/web` 執行 `bunx wrangler secret put GATEWAY_WEBHOOK_SECRET --env <preview|production>`。缺少時 webhook 端點回 503，導回查詢仍可讓顧客看到最新狀態。

本機開發見 `apps/app/.dev.vars.example` 與 `apps/web/.dev.vars.example`。

### 退款（逐筆記錄與安全重試）

依 ADR 0007 與設計文件 A8（Migration `0024_refunds.sql`；`apps/app/src/payments/refunds.ts`、`refund.ts`、`service.ts` 的 `runRefund`）。退款不再是付款上的一個狀態：每筆退款是 `refunds` 的一列（訂單、付款、原因、金額，拆成 `goods_twd` 商品款與 `shipping_twd` 原運費、進度、登記與成功時間），每次向閘道送出或查證在 `refund_attempts` 留一列（時間、操作者 `system` 或管理員 email、動作、結果、錯誤碼，只增不改）。本票只涵蓋既有的三種付款異常（遲到無法重新保留、落在已取消訂單、第二筆成功付款），仍是退應退全額，**沒有任意金額的手動退款**；部分取消、退貨與發票折讓（#116、#121、#122）直接讀 `refunds`：同一筆付款可有多筆退款，新增退款一律走 `commitRefund`（單句 INSERT…SELECT，實收減去所有已登記退款——含 pending、processing、unknown、failed、succeeded——不足就不寫入，以 `changes` 判斷，並行承諾不會超額），不要先讀額度再寫。

- 進度（`REFUND_STATUSES`）：`pending` 已登記尚未送出（含等同單前一筆）、`processing` 送出或查證中、`unknown` 結果不明（逾時、連不上、5xx、408、429、回應格式異常或金額對不上）、`failed` 閘道明確拒絕（退款失敗或其他 4xx）、`succeeded`。除 `succeeded` 外都佔用付款的可退額度；失敗那筆保留額度並列待辦，不會把同一筆可退金額重新承諾給別人。
- 冪等：閘道的冪等鍵存在 `refunds.gateway_refund_id`（新紀錄 `rf_<UUID>`，登記時由應用程式產生、隨 INSERT 寫入，之後沒有任何程式會改它，所以同一筆退款的重送、重試與查證永遠帶同一個 ID；0024 搬來的舊退款是 `legacy_<閘道付款 ID>`，對得上閘道 0002 搬來的退款），同一筆的重送、重試與重複事件都指到同一筆，閘道不會多退。付款層級的原因（遲到、已取消、重複）每個原因一筆付款最多一筆（部分唯一索引 `refunds_payment_reason_uidx`，登記的 `ON CONFLICT` 只針對它，其他唯一衝突會丟錯；整筆退款另受額度條件限制），付款成功事件重送（含同時送達）只登記並退款一次；付款結果已套用但退款登記前程序中斷時，同一事件重送會補登記。
- 同單互斥：開始執行前先以單句條件 UPDATE 搶執行權（`claimRefund`），同張訂單一次最多一筆在 `processing`，且同單有 `unknown` 或 `processing` 的退款時其他筆不能開始（RPC 回 `refund_blocked`，不論租約是否過期）；明確失敗不阻擋後筆。卡在 `processing` 超過 60 秒（`REFUND_CLAIM_LEASE_MS`，程序中斷）視為租約過期，租約只決定那一筆能否被下一次操作先查證再接手，查證結案前它仍阻擋同單後筆。
- 結果不明先查再決定：`unknown`（或租約過期）的退款，重試時先 `GET .../refunds/:refundId` 向閘道查證——已成功就記成功、不重送；說失敗或從未收過，才用同一個退款 ID 送出；查證本身失敗仍是不明。**不會**盲目重送。
- 觸發與重試：付款成功卻沒讓訂單成立時，由搶到事件的那次呼叫登記並以 `system` 立即執行（閘道設定不全時退款留在 `pending`，記 `payment_refund_not_started` log）。失敗、不明與等待中的退款不會自動重試（沒有 Cron），也不會在前筆結案後自動接續，由管理員在 `/admin/refunds`（導覽「退款待辦」；RPC `listRefundsToHandle`、`retryRefund`）按「重試」／「查證並重試」；操作者與每次結果留在嘗試紀錄，後台訂單明細的「退款」表也看得到。
- 通知與顧客可見：退款成功時 `refund_succeeded` 通知信與狀態同一個 batch 寫入（沿用 #109 outbox，重試不重複）。顧客在訂單頁「退款進度」逐筆看到金額、原因與進度，只分「退款處理中」與「已退回原付款方式」，不揭露內部的不明與失敗，也看不到嘗試紀錄與操作者；`getMyOrder`／`listMyOrders` 永遠限定本人。管理員的 RPC 與頁面沿用 Cloudflare Access 驗證。
- 舊資料：0024 把舊的 `payments.status = refunded／refund_failed` 與 `refund_reason`、`refund_at` 搬成 `refunds`（`refunded` → `succeeded`、`refund_failed` → `unknown`——舊版逾時也記成 `refund_failed`，分不出明確失敗，所以重試時先向閘道查證；金額取付款實收，運費取訂單的運費快照，其餘為商品款），付款狀態一律回到 `succeeded`，並移除舊欄位與狀態值；沒有相容層。
- 閘道（模擬服務）：新增 `refunds` 表與部分退款 API（見「模擬金流閘道」）；舊的 `POST /v1/payments/:id/refund` 與 `payment.refunded` 事件已移除，付款狀態不再有 `refunded`／`refund_failed`（0002 把舊資料轉成一筆全額成功的退款）。
- 部署順序：先 migration（閘道 0002、App 0024），再閘道、App，最後 Web；新 App 呼叫閘道的新退款 API，舊閘道不認得，所以閘道必須先部署。回復：先停止寫入並先回復 Web 與 App，再執行 `wrangler d1 execute <DB> --file apps/app/rollback/0024_refunds.down.sql`；0024 之後有任何退款嘗試紀錄、尚未成功也未明確失敗的退款、同一筆付款多筆退款或部分退款時（舊的 `unknown` 會寫回 `refund_failed`），守門檢查讓回復失敗（舊模型表達不了），須先處理或確認可以捨棄。閘道 0002 沒有回復腳本（模擬服務，資料可重建）。
- 測試：`apps/app/test/refunds.test.ts`（拆分與綁定的收款、明確失敗保留額度且後筆前進、重試沿用同一筆、不明先查並阻擋後筆、租約、並行與重複事件、權限與可見範圍）、`refunds-migration.test.ts`（資料搬遷、CHECK、回復）、`gateway-client.test.ts`（閘道契約）；閘道的部分退款契約在 `apps/gateway/test/refund.test.ts`；Web 文案在 `apps/web/src/orders/labels.test.ts`、`admin/refund.test.ts`；手機與桌機操作（待辦重試、查證、顧客進度與通知、顧客不能進待辦頁）由 `e2e/tests/refunds.spec.ts` 驗證。

### 部分取消（取消申請與逐案退款）

依 ADR 0007 與設計文件 A4、A7、A8（Migration `0025_cancellations.sql`；`apps/app/src/cancellations/`）。顧客對已付款、尚未交運的明細數量提出**取消申請**，管理員核准或拒絕；核准的每案各自登記一筆退款，走 #115 的逐筆退款（同單互斥、不明先查證、失敗重試沿用原紀錄）。

- 資料：`cancellation_requests`（訂單、冪等鍵 `request_key` 與內容指紋、進度 `pending`／`approved`／`rejected`、申請原因、審核人／時間／備註、核准時算定的 `goods_twd`、`standard_shipping_twd`、`large_shipping_twd`）與 `cancellation_request_items`（申請明細）；`refunds` 新增原因 `cancellation` 與 `cancellation_request_id`（唯一索引，一案最多一筆退款，核准重送不重複登記）。
- 數量只有一個來源：明細數量 = 已交運 + 取消申請占用（待審與核准）+ 可再動用。申請（`requestCancellation`）與交運（`shipOrder`）都用同一個條件寫入各自的 batch，並行時以 batch 落地順序為準：申請先成立就凍結該數量的交運（仍占已付款保留，可售不變）；交運先成立，已交運的數量申請不了（走退貨）。同一明細重複申請被同一個占用條件擋下，不會重複取消。拒絕後數量不再被占用，恢復可交運。
- 核准（`decideCancellation`，管理 RPC，沿用 Access 驗證）是單一 batch：待審 → 核准並算定退款拆分、訂單狀態（每筆明細都核准取消 → 已取消；其餘剩餘數量都已交運 → 已出貨）、登記這一案的退款（額度條件與其他退款共用 `withinQuotaSql`：成功加所有未結承諾不超過實收）、核准通知同成同敗。核准即釋放保留（保留量減去已核准取消）、停止履約；之後才向閘道執行退款，退款失敗或被前筆阻擋都不改變取消結果、不恢復出貨，留在退款待辦重試。額度被其他退款占用時核准照樣成立但不登記退款（頁面標示「退款尚未登記」），重送核准會再嘗試。
- 金額：商品款 = 取消數量 × 下單時的單價快照（`order_lines.unit_price_twd`，即成交的實付單價；本專案沒有優惠券或滿額折扣，特價已反映在售價，改價不影響）。某配送類型的原運費（取自訂單的運費快照）只在「該類每筆明細都已全數取消」的那一案退，且訂單上沒有其他已核准的案件退過該類運費（以核准時寫在案件上的運費欄位為準，所以任何核准順序下同類最多退一次）；部分取消不退運費，舊單運費為零就退零。
- 顧客：訂單頁「取消申請」表單（每筆可取消的明細一個數量欄，表單渲染時產生冪等鍵）與申請紀錄（進度、審核說明、退款），明細顯示「已取消」「取消審核中」；審核與退款結果寄 `cancellation_approved`／`cancellation_rejected`／`refund_succeeded` 通知。管理員：`/admin/cancellations`（導覽「取消審核」，RPC `listCancellationsToReview`）列出待審案件，在訂單頁核准或拒絕並寫備註；訂單頁與退款待辦顯示各案與各筆退款。顧客 RPC `requestCancellation`、`getMyOrder` 永遠限定本人。
- 狀態轉換：`paid` 新增可轉 `cancelled`（全部數量核准取消）；顧客自行取消訂單仍只限待付款（`cancelOrder` 與 `cancelPendingOrder` 另外限定來源）。
- 尚未實作：ADR 0008（明確失敗的退款能否人工結案）仍是待決，本票不提供人工結案；物流異常與發票折讓是後續票（退貨見下一節）。
- 部署順序：先 migration，再 App，再 Web（新 App 的 `getOrderForAdmin`、`getMyOrder` 多回傳 `cancellations`，明細多回傳 `cancelledQuantity`、`pendingCancellationQuantity`，舊 Web 不受影響）。0025 重建 `refunds`（CHECK 要加新原因），做法同 0021、0024（備份、砍表、建表、寫回並還原 AUTOINCREMENT 計數）。回復：先停止寫入並先回復 Web 與 App，再執行 `wrangler d1 execute <DB> --file apps/app/rollback/0025_cancellations.down.sql`；已有任何取消申請或取消退款時守門檢查讓回復失敗（核准的取消已停止履約並釋放保留，舊版無法表達），須先確認可以捨棄。回復順序是 0025 → 0024 → …。
- 測試：`apps/app/test/cancellation-request.test.ts`（申請凍結交運、與交運及重複申請的並行、冪等、權限與輸入）、`cancellation-decide.test.ts`（拒絕解凍、核准釋放與實付單價、運費一次、退款失敗不恢復出貨、同單逐筆、額度、重複核准）、`cancellations-migration.test.ts`；Web 的表單解析與文案在 `apps/web/src/orders/cancellation.test.ts`、`admin/cancellation-form.test.ts`，手機與桌機操作由 `e2e/tests/cancellations.spec.ts` 驗證（375／1280 寬，含無障礙掃描與顧客不能進審核頁）。

### 退貨（人工受理、收回、檢查與逐案退款）

依 ADR 0006、0007 與設計文件 A6、A7（Migration `0026_returns.sql`；`apps/app/src/returns/`、`stock/scrap.ts`、`payments/exit-refund.ts`）。顧客對**已交運**的明細數量提出退貨申請（人工受理入口不依自助退貨期限擋下；逐批自助申請見下面「自助退貨窗口」；換貨走退貨退款再下單，不補寄、不補差價），管理員審核、記錄收回、記錄檢查，檢查完成才按實際收到的數量退款。實物與款項分開記錄：任何一邊失敗都不反轉另一邊已發生的事實。

- 資料：`return_requests`（訂單、冪等鍵與內容指紋、進度 `pending`／`approved`／`rejected`／`received`／`not_received`／`completed`、審核／收回／檢查各自的操作人、時間與備註、檢查完成時算定的退款拆分）與 `return_request_items`（明細：申請數量、實際收到、良品、損壞品，CHECK 保證良品加損壞等於實收且不超過申請）；`refunds` 新增原因 `return` 與 `return_request_id`（一案一筆的唯一索引）；`product_variants.unavailable` 與庫存流水的不可售欄位（見「庫存」）。
- 數量：退貨數量以「已交運且未退貨」為上限。占用（`returns/queries.ts` 的 `heldByReturnQuantity`）：待審與核准占用申請數量，收回後占用實際收到的數量（沒收到的釋出），檢查完成維持已退貨，拒絕與未收到釋出。申請（`requestReturn`）用一句條件寫入保證「占用 + 本次 ≤ 已交運」，所以重複、並行與已退過的數量被擋下。取消申請只動未交運的數量、退貨只動已交運的數量，兩者是明細數量的互斥部分，不會重複占用。
- 流程（管理 RPC，沿用 Access 驗證，都是單一 batch、冪等）：`decideReturn` 核准或拒絕（不動庫存與款項，寫通知）；`recordReturnReceipt` 每筆明細填實際收到數量（不超過申請），**收到實物才**在庫與不可售各加收到數量（流水 `return_received`），全部填 0 則記為「未收到」結案、不動庫存；`recordReturnInspection` 良品加損壞品等於實收，良品由不可售轉可售（在庫不變，流水 `return_inspected`）、損壞品留在不可售，並在同一個 batch 算定退款、登記該案退款、寫完成通知。重送同內容回 `replayed: true`，不同內容回 `return_wrong_state`；收回與檢查的庫存轉換靠「這案還沒有對應流水」只做一次。
- 報廢：`scrapUnavailableStock`（變體、數量、必填原因）同時減少實體在庫與不可售，可售不變，寫 `scrap` 流水；只能報廢「不可售 − 待檢」（變體回傳 `scrappable`），也就是已檢查確認的損壞品，已收回但尚未檢查的退貨不能報廢；報廢以變體為單位，流水不連到退貨案（`return_request_id` 為空，以原因與操作人稽核），因為不可售是變體層級的混合庫存。
- 金額：商品款 = 實際收到數量 × 下單時的單價快照（良品與損壞品都退；收回運費由商家負擔，不向顧客收）。某配送類型的原運費只在「該類每筆明細都全數退出（核准取消 + 完成檢查的退貨）」時退一次（`payments/exit-refund.ts`，取消核准與退貨檢查共用同一份判斷），且訂單上沒有其他已核准的取消或已完成的退貨退過該類運費；所以取消與退貨混合、任何先後順序，同類運費最多退一次，部分不退，待審、在途與待檢的數量尚未算退出。
- 退款：與取消相同，登記在檢查完成的同一個 batch（額度共用 `withinQuotaSql`），之後才向閘道執行；退款失敗、被前筆阻擋或額度被占用都不反轉收回與庫存轉換，退款留在退款待辦（額度不足而未登記的列在 `listRefundsToHandle` 的 `unregisteredReturns`，訂單頁「重新登記退款」＝重送同一份檢查結果）。
- 顧客：訂單頁「退貨申請」表單與紀錄（進度、審核說明、實際收到數量、退款），明細顯示「已退貨」「退貨處理中」；RPC `requestReturn`、`getMyOrder`（多回傳 `returns`）永遠限定本人。管理員：`/admin/returns`（導覽「退貨處理」，RPC `listReturnsToHandle`）列出待審、待收回、待檢查的申請與不可售庫存（含報廢表單），在訂單頁審核、記錄收回與檢查；庫存流水頁顯示在庫與不可售的增減。
- 自助退貨窗口（#118，Migration `0027_return_batches.sql`；`returns/window.ts`、`returns/batches.ts`）：`requestReturn` 的明細帶 `shipmentId` 是自助申請（逐批，同一次提交要嘛全帶要嘛全不帶），不帶是人工受理。窗口以**各批**實際送達時間（`shipments.delivered_at`）計算：送達日（台北日曆日，UTC+8）的隔日為第 1 天，第 7 天 23:59:59 之後（第 8 天 00:00:00）關閉；送達當日本身可申請。窗口、該批「數量 − 該批已被自助占用」與明細層占用條件在同一句 INSERT 裡檢查，所以並行與重複申請不會超量；批次對應記在 `return_request_batches`（人工受理沒有批次列）。逾期回 `return_window_closed`、批次未送達或沒有可靠送達日（遷移補建的舊批次，不補假日期）回 `shipment_not_delivered`、批次不屬於這張訂單或不含該明細回 `return_batch_invalid`；這三種都不是否決，顧客用不帶批次的人工受理仍可申請並由客服審核。送達時間被較早的回報改寫時，期限隨之提前，只影響之後的申請（已成立的申請與同鍵重送不受影響）。`getMyOrder` 多回傳 `returnBatches`（各批窗口狀態、結束時間與各明細可自助數量），退貨申請多回傳 `selfService`；訂單頁分「依各批送達日自助申請」與「人工受理」兩個表單。批次不分開記錄實際收回數量，所以部分收回後未收到的部分在明細層釋出、該批的自助占用維持申請數量（之後走人工受理）。
### 確認物流遺失（#119）

依 ADR 0006、0007 與設計文件 A6、A7（Migration `0028_shipment_losses.sql`；`apps/app/src/shipments/loss.ts`、`loss-queries.ts`、`loss-input.ts`，運費判斷在 `payments/exit-refund.ts`）。管理員在訂單頁的批次清單「確認遺失」（RPC `confirmShipmentLoss`，輸入 `shipmentId`、表單一次提交的冪等鍵 `lossKey`、遺失明細與數量、備註）：退受影響商品數量（按原實付單價）與符合條件的該類原運費，**不回補庫存**（貨已交運、不在倉內，不寫流水）、**不補寄**（需要再購買須重新下單）。

- 資料：`shipment_losses`（一案一列：訂單、批次、`loss_key`、內容指紋、確認人與時間、建立時算定的商品款與兩類運費）與 `shipment_loss_items`（明細數量，大於 0）；`refunds` 新增原因 `loss` 與 `shipment_loss_id`（一案最多一筆退款，唯一索引）。`shipments.delivery_status` 新增 `lost`。
- 與物流回報的先後：只能確認尚未送達的批次（已送達是終點，回 `shipment_delivered`）；暫時配送失敗、再次配送都**不是**遺失，遺失一定來自管理員確認，失敗或再次配送中的批次可以確認。確認後批次進度恆為 `lost`，優先於所有回報；確認之後才到的送達、失敗、再次配送回報只留紀錄（不改進度、不寄通知；送達回報仍記錄 `delivered_at`，但遺失的數量不因此回到可退貨或可交付）。確認與送達回報以同一份資料庫條件競爭，只有先提交的那一邊生效。
- 數量：確認遺失與退貨申請（#117／#118）共用同一份數量，同一句條件寫入互斥：遺失 ≤ 該批數量 − 該批自助退貨占用 − 該批已遺失，且明細「已遺失 + 退貨占用 + 本次」≤ 已交運數量；退貨申請另扣遺失（`shipments/queries.ts` 的 `lostQuantity`、`lostInBatchQuantity`）。待審與核准中的退貨也占用，須先處理（拒絕後可遺失）。超量回 `loss_quantity_exceeded`，明細不在這一批回 `loss_line_invalid`。
- 運費：任一該類明細遺失，就退該類原運費快照一次，即使同類其他批已送達；取消、退貨、遺失共用「這一類原運費已退過」的紀錄（各案的運費欄位），任何先後順序同類最多退一次；遺失數量計入「退出履約」，所以遺失在先時，之後取消或退貨補足全退出也不再退運費。
- 退款：與取消、退貨相同模式——確認的同一個 batch 內登記退款（`withinQuotaSql` 單句條件寫入，`gateway_refund_id` 由應用程式產生），額度不足時遺失照常成立，列進退款待辦（`listRefundsToHandle` 的 `unregisteredLosses`），重送同一確認（同 `lossKey`）會再嘗試登記並執行；退款失敗或結果不明不反轉遺失事實，沿用 ADR 0007 的逐筆退款與重試。通知（`shipment_loss_confirmed`）與確認同一個 batch 寫入，依退款是否已登記分文案。
- 讀取：`getMyOrder` 多回傳 `losses`（顧客只看自己的訂單），`getOrderForAdmin` 多回傳 `losses`（含確認人與 `lossKey`），訂單明細多回傳 `lostQuantity`；不認得 `lost` 的舊 Web 顯示「進度未知」。
- 部署順序：先 migration，再 App，再 Web。回復：先停止寫入並先回復 Web 與 App，再執行 `wrangler d1 execute <DB> --file apps/app/rollback/0028_shipment_losses.down.sql`（已有任何確認遺失、遺失退款或 `lost` 批次時守門檢查讓回復失敗，須先確認可以捨棄）。回復順序是 0028 → 0027 → …。0028 重建 `refunds`（CHECK 要加新原因），做法同 0026。
- 測試：`apps/app/test/shipment-loss.test.ts`（退款與庫存、與物流回報的先後與亂序、數量與退貨互斥含並行、運費互斥與取消／退貨交錯、退款失敗與額度占用的復原、冪等、權限與輸入）、`shipment-losses-migration.test.ts`（遷移、約束與回復）、`apps/web/src/admin/loss-form.test.ts`、`e2e/tests/shipment-loss.spec.ts`（手機與桌機）。
### 物流退回入倉檢查後退款（#120）

依 ADR 0006、0007 與設計文件 A6、A7、Q13、Q25（Migration `0029_shipment_returns.sql`；`apps/app/src/shipment-returns/`：`declare.ts`、`receive.ts`、`inspect.ts`、`quantities.ts`、`queries.ts`、`input.ts`，共用庫存轉換在 `stock/conversion.ts`，運費判斷在 `payments/exit-refund.ts`）。物流把尚未送達的商品送回倉庫，與顧客收貨後的退貨申請分開追蹤，三步由管理員在訂單頁操作：**登記**（RPC `declareShipmentReturn`，輸入 `shipmentId`、表單一次提交的冪等鍵 `returnKey`、明細數量與備註）→ **收回**（`recordShipmentReturnReceipt`，每筆明細填實際收到的數量）→ **檢查**（`recordShipmentReturnInspection`，每筆填良品與損壞品數量）。回倉後不恢復原單履約：已交運的數量維持已交運、不從同單補寄，再購須重新下單。

- 資料：`shipment_returns`（一案一列：訂單、批次、`return_key`、內容指紋、進度 `returning`／`received`／`not_received`／`completed`、各步驟操作人與時間與備註、檢查完成時算定的商品款與兩類運費）與 `shipment_return_items`（`quantity` 退回數量、`found_lost_quantity` 尋回的遺失品、收回與檢查的實際數字）；`refunds` 新增原因 `shipment_return` 與 `shipment_return_id`（一案最多一筆，唯一索引）；`stock_movements` 新增 `shipment_return_id` 與來源 `shipment_return_received`、`shipment_return_inspected`；`shipments.delivery_status` 新增 `returned`。
- 庫存（Q13，與退貨同一套轉換，`stock/conversion.ts` 的 `receiveIntoStock`、`convertInspectedToSellable`，退貨的收回與檢查也改用它，沒有複製第二份）：登記不動庫存與款項；實際收回才增加實體在庫與不可售（待檢，可售不變）；檢查合格把不可售轉可售（在庫不變）、損壞品留在不可售直到報廢（`stock/scrap.ts`，待檢數量含物流退回，不能報廢）。收回與檢查都在同一個 batch 寫流水，並以「這案尚無對應流水」為冪等閘，重送不重複入庫。一件都沒收到則 `not_received` 結案、不動庫存、占用釋出。
- 批次結局與物流回報的優先序：遺失 > 物流退回（`returned`）> 送達 > 配送失敗 > 再次配送。只能登記尚未送達的批次（已送達是終點，回 `shipment_delivered`）；登記之後才到的送達、失敗、再次配送回報只留紀錄（不改進度、不寄通知；送達回報仍記錄 `delivered_at`）；部分退回之後才送達的批次仍是 `returned`，送達通知只列未退回的數量，全數退回的批次不寄送達通知。登記與送達回報以同一份資料庫條件競爭，先提交的一邊生效；已遺失的批次再登記退回仍是 `lost`。
- 數量互斥：物流退回、退貨申請（#117／#118）與確認遺失（#119）共用同一份數量，同一句條件寫入互斥：退回 ≤ 該批數量 − 該批已遺失 − 該批自助退貨占用 − 該批已退回，且明細「已遺失 + 退貨占用 + 物流退回占用 + 本次」≤ 已交運數量；退貨申請與確認遺失另扣物流退回占用（`heldByShipmentReturnQuantity`、`returnedInBatchQuantity`）。登記與收回前占用登記的數量，收回後占用實際收到的數量（沒收到的釋出），完成維持實際收到的數量。
- 與確認遺失的關係：遺失已退款的貨若之後被物流尋回並退回倉庫，登記時在明細填「尋回的遺失品」（不得超過該批已確認遺失、扣掉已尋回的數量；不占新的份額，遺失紀錄與退款不變，仍算遺失、不可再退貨）。收回時照樣入庫（實物回到倉內，可檢查轉可售或隔離），但**不再退款**：商品款只按實際收回的退回數量計算。
- 尋回路徑的限制：批次一旦有實際送達時間（`delivered_at`），就不能再登記物流退回，所以「部分遺失 → 其餘送達 → 遺失的貨之後被尋回」這條路徑沒有對應的流程，只能由管理員用庫存調整手動入庫（不退款，遺失的款項早已退過）。
- 未收到結案：一件都沒收到而結案（`not_received`）後，批次進度由 `derivedDeliveryStatusSql`（`shipments/queries.ts`，與記錄物流回報共用）在同一個 batch 重算，不再停在 `returned`，之後的送達與失敗回報照常處理與寄信。
- 運費（Q25，優先於 Q15 的一般全退出規則）：只要這案實際收回的明細裡有某一類，且該類原運費沒被取消、退貨、遺失或別案物流退回退過，就退該類原運費快照一次，即使同類其他商品已送達；各案的運費欄位是「已退過」的共同紀錄，任何先後順序同類最多退一次；物流退回的數量計入「退出履約」，所以取消或退貨補足全退出時也不再重退。
- 退款與通知：與取消、退貨、遺失相同模式——檢查完成的同一個 batch 內登記退款（`withinQuotaSql` 單句條件寫入），額度不足時檢查結果照樣成立，列進退款待辦（`listRefundsToHandle` 的 `unregisteredShipmentReturns`），重送同一次檢查會再嘗試登記並執行；退款失敗或結果不明不反轉已發生的實物事件，沿用 ADR 0007 的逐筆退款與重試。通知（`shipment_return_declared`、`shipment_return_completed`）與各步驟同一個 batch 寫入，漏掉時重送同一次登記或檢查會補回，完成通知依退款是否已登記、有無應退金額分文案；退款完成另有退款成功通知。
- 讀取：`getMyOrder` 多回傳 `shipmentReturns`（顧客只看自己的訂單，不含備註、操作人與冪等鍵），`getOrderForAdmin` 多回傳 `shipmentReturns`，訂單明細多回傳 `shipmentReturnedQuantity`，批次明細多回傳 `returnedQuantity`；庫存流水多回傳 `shipmentReturnId`。不認得 `returned` 的舊 Web 顯示「進度未知」。
- 畫面：後台訂單頁批次清單的「登記物流退回」表單，與「物流退回」區塊（收回、檢查、重新登記退款）；顧客訂單頁「被物流退回倉庫的商品」；退款待辦頁列出未登記退款的物流退回；手機與桌機皆可操作（e2e 驗證）。
- 部署順序：先 migration，再 App，再 Web。回復：先停止寫入並先回復 Web 與 App，再執行 `wrangler d1 execute <DB> --file apps/app/rollback/0029_shipment_returns.down.sql`（已有任何物流退回、物流退回退款、物流退回庫存流水或 `returned` 批次時守門檢查讓回復失敗，須先確認可以捨棄）。回復順序是 0029 → 0028 → 0027 → …。0029 重建 `refunds`（CHECK 要加新原因），做法同 0028；回復時重建 `stock_movements`（含外鍵的欄位不能 DROP COLUMN），並還原只增不改不刪的 trigger。
- 測試：`apps/app/test/shipment-return.test.ts`（入倉與庫存、損壞品與報廢、未收到與部分收回、運費互斥與取消／退貨／遺失交錯、尋回的遺失品、與物流回報的先後與亂序、數量互斥含並行、退款失敗與額度占用的復原、冪等與漏通知補回、權限與輸入）、`shipment-returns-migration.test.ts`（遷移、約束與回復）、`apps/web/src/admin/shipment-return-form.test.ts`、`e2e/tests/shipment-return.spec.ts`（手機與桌機）。
- 尚未實作：ADR 0008 仍待決（本票的退款失敗同取消、退貨、遺失，沒有人工結案）；物流退回案件沒有獨立的待辦清單，管理員從訂單頁處理。
- 部署順序：先 migration，再 App，再 Web（新 App 的 `getOrderForAdmin`、`getMyOrder` 多回傳 `returns`，明細多回傳 `returnedQuantity`、`openReturnQuantity`，變體多回傳 `unavailable`，舊 Web 不受影響；0027 只新增一張表，回復腳本 `apps/app/rollback/0027_return_batches.down.sql` 在已有批次對應時守門檢查讓回復失敗，回復順序 0027 → 0026 → …）。0026 重建 `refunds`（CHECK 要加新原因），做法同 0021、0024、0025。回復：先停止寫入並先回復 Web 與 App，再執行 `wrangler d1 execute <DB> --file apps/app/rollback/0026_returns.down.sql`；已有任何退貨申請、不可售數量、不可售流水或退貨退款時守門檢查讓回復失敗（收回與檢查已改變實體與不可售，舊版無法表達），須先確認可以捨棄。回復順序是 0026 → 0025 → …。
- 測試：`apps/app/test/return-request.test.ts`（申請、占用、並行、冪等、權限與輸入、審核）、`return-flow.test.ts`（收回、檢查、報廢、可售算式、運費與取消混合）、`return-refund.test.ts`（退款失敗不反轉實物、額度占用、同單逐筆）、`return-self-service.test.ts`（自助窗口邊界：送達當日、第 7 天 23:59:59、第 8 天 00:00:00，台北日曆日、各批各自期限、送達時間被較早回報改寫、未送達與無送達日、批次數量與並行、冪等、權限）、`returns-migration.test.ts`（遷移、約束與回復，含 0027）、`e2e/tests/returns.spec.ts`（手機與桌機完整流程）、`e2e/tests/return-self-service.spec.ts`（未送達只有人工受理、送達後自助申請、管理員看到自助申請、顧客隔離）。

### 模擬發票（#121）

依設計文件「發票、通知與進度」與 A10（Migration `0030_invoices.sql`；`apps/app/src/invoices/`）。只演練一般個人消費者的 email 交付：沒有統編、載具、捐贈，也不是真實電子發票。

- 開立義務（outbox）：每筆**成功收款**一張發票，原額等於那筆收款的實收。付款轉為成功的同一個 batch（`applyPaymentEvent`）寫入一列 `invoices`（`pending`，`payment_id` 唯一，所以事件重送、導回查詢與補查都不會登記第二張）；batch 之後、交易之外才向發票服務開立。包含訂單沒讓它成立的成功付款（遲到、已取消、重複付款）：每筆收款各自一張，各自原額。
- 冪等與不重複：發票服務以 `invoices.gateway_invoice_key`（`inv_<UUID>`，登記時產生、之後永不更改）為冪等鍵，同一個鍵重送、並行與補辦都回同一張發票；本地狀態只會有一次轉為已開立（`recordInvoiceAttempt` 的條件 UPDATE），發票通知信的事件鍵唯一，所以只有一張發票、一封通知。
- 失敗不阻擋、可補辦（比照 #115 退款）：進度 `pending`（待開立）、`unknown`（結果不明）、`failed`（明確失敗）、`issued`（已開立）。發票服務明確拒絕（`invoice_failed` 或 4xx）記 `failed`；連不上、逾時、5xx、回應異常記 `unknown`，補辦時**先向發票服務查證**（`GET /v1/invoices/:invoiceKey`）：已開立就記成功、不重送，從未收過才以同一個鍵送出；回應的鍵、金額、訂單參照與本站不符一律當作不明。每次嘗試（操作者、動作、結果、錯誤碼）留在 `invoice_attempts`。付款、出貨與退款都不看發票狀態。系統只在付款事件進來時開立一次（含事件重送補開 `pending`）；失敗與不明沒有 Cron，由管理員在 `/admin/invoices`（導覽「發票待辦」；RPC `listInvoicesToHandle`、`retryInvoice`）按「補辦」／「查證並補辦」。發票服務與金流閘道同一組設定（`GATEWAY_BASE_URL`、`GATEWAY_API_KEY`），設定不全時補辦回 `payment_unavailable`，開立義務留著。
- 憑證交付與重寄：開立成功時寫一封 `invoice_issued`（發票號碼與開立當時的原額，內容固定）到顧客的模擬信箱，收件地址是當下已驗證的聯絡 email。管理員在後台訂單頁「發票」表按「重寄憑證」（RPC `resendInvoice`）＝同一封信的新投遞（沿用 `resendMessage`），寄到顧客**目前**已驗證的 email（沒有回 `no_verified_contact`），不改既有投遞紀錄、信件內容與發票；尚未開立回 `invoice_not_issued`。
- 待折讓義務（逐筆折讓見「模擬發票折讓（#122）」）：每筆**成功**的退款一列 `allowance_obligations`（`refund_id` 唯一），與退款轉為成功同一個 batch 寫入——退款轉 `succeeded` 的唯一寫入點是 `recordRefundAttempt`，所以取消、退貨、遺失、物流退回與付款異常的退款（含失敗後重試成功的「後續成功退款」）都會建立；0030 另為遷移前已成功的退款補義務、為已成功的收款補待開立的發票義務（冪等鍵 `inv_legacy_<付款編號>`）。義務綁定收款而不是發票：退款可能先於延遲開立的發票成功，先保留退款事實，原票開立後仍是原額，義務不變。
- 只顯示原額：顧客與管理員看到的 `amountTwd` 永遠是開立原額，`pendingAllowanceTwd` 是已成功退款但憑證尚未折讓的合計，畫面標示「憑證待補」並說明原票沒有扣除退款；**沒有「剩餘金額」或「已結清」**。逐筆折讓於 #122 完成，見下一節；ADR 0008 人工結案同樣未實作。
- 模擬服務（`apps/gateway`，見「模擬金流閘道」）：`POST /v1/invoices`、`GET /v1/invoices/:invoiceKey`；開發主控頁可切換「下一次開立失敗」與「下一次開立已成立但回應遺失」演練失敗與延遲（結果不明）。
- 畫面：顧客訂單頁「發票」（只分「已開立」與「開立中」，不揭露內部的失敗與不明；有待折讓時標「憑證待補」）、後台「發票待辦」（待開立發票與憑證待補清單）、後台訂單頁「發票」（嘗試紀錄、待折讓、補辦／重寄）；手機與桌機皆可操作（e2e 驗證）。
- 部署順序：先停止寫入，再套用 migration（App 的 `0030_invoices.sql` 與閘道的 `0003_invoices.sql`），然後部署閘道、App，最後 Web，與 0024、0029 一致；新 App 在付款成功時會寫 `invoices`，0030 缺表時付款結果的套用會整批失敗，所以 migration 必須先套用。閘道 0003 只新增資料表、沒有回復腳本（模擬服務，需要時整張刪除即可）。
- 安全網（新 App 上線後執行一次，冪等可重跑）：migration 套用到新 App 上線之間若有付款成功，那筆收款（舊 App 寫入、沒有開立義務）與成功退款不會有義務。執行下列兩句補登（與 0030 末兩句相同，加 `ON CONFLICT DO NOTHING`，已存在的不動）：

  ```sql
  INSERT INTO invoices (order_id, payment_id, gateway_invoice_key, amount_twd, status, created_at)
  SELECT order_id, id, 'inv_legacy_' || id, amount_twd, 'pending', created_at FROM payments WHERE status = 'succeeded'
  ON CONFLICT (payment_id) DO NOTHING;
  INSERT INTO allowance_obligations (refund_id, payment_id, order_id, amount_twd, created_at)
  SELECT id, payment_id, order_id, amount_twd, COALESCE(settled_at, created_at) FROM refunds WHERE status = 'succeeded'
  ON CONFLICT (refund_id) DO NOTHING;
  ```

  套用 0031（#122）之後，待折讓義務多了冪等鍵與狀態欄位，補登義務改用下面這句（冪等鍵 `alw_late_<退款編號>`，與 0031 為舊義務補的 `alw_legacy_<義務編號>` 不會相撞；補登的義務停在待折讓，原票開立後或管理員補辦才送出）：

  ```sql
  INSERT INTO allowance_obligations (refund_id, payment_id, order_id, amount_twd, created_at, gateway_allowance_key, status)
  SELECT id, payment_id, order_id, amount_twd, COALESCE(settled_at, created_at), 'alw_late_' || id, 'pending' FROM refunds WHERE status = 'succeeded'
  ON CONFLICT (refund_id) DO NOTHING;
  ```

- 舊收款（遷移前或補登的）只能逐張補辦：它們停在「待開立」，系統只在付款事件進來時開立，沒有 Cron 也沒有批次補開，管理員要在 `/admin/invoices` 逐張按「補辦」。
- 付款確認路徑的延遲：開立在套用付款結果的同一個請求裡、batch 之後同步呼叫發票服務（webhook、導回查詢與補查都是），所以發票服務慢時（逾時上限 5 秒）這些請求會變慢，但結果不受影響。折讓同樣在退款成功與原票開立之後同步呼叫發票服務，每次最多 5 秒。沒有改成 `ctx.waitUntil`：測試與冪等補開依賴「套用結果回傳時開立已有結果」，且 App 的服務層沒有執行環境的 context。
- 回復：先停止寫入並先回復 Web 與 App，再執行 `wrangler d1 execute <DB> --file apps/app/rollback/0030_invoices.down.sql`（已有已開立的發票，或任何開立嘗試紀錄——含結果不明，發票服務那邊可能已開立——時守門檢查讓回復失敗；其餘由收款與退款推得、重新套用會補回）。回復順序是 0030 → 0029 → …。
- 測試：`apps/app/test/invoices.test.ts`（開立一次與重送不重複、失敗與不明與查證、補辦並行、重寄憑證、權限、待折讓義務與先後順序）、`invoices-migration.test.ts`（遷移補資料、約束與回復）、`apps/gateway/test/invoice.test.ts`、`apps/web/src/admin/invoice.test.ts`、`apps/web/src/orders/invoice.test.ts`、`e2e/tests/invoices.spec.ts`（手機與桌機）。

### 模擬發票折讓（#122）

依設計文件 A10（Migration `0031_allowances.sql`；`apps/app/src/invoices/allowance-service.ts`、`allowance-queries.ts`）。每筆成功退款在模擬發票上折讓一次，金額是該筆退款原額，累計折讓不超過原票金額；折讓失敗或延遲不阻擋付款、出貨或退款。

- 義務即折讓：`allowance_obligations`（#121 建立，每筆成功退款一列）多了 `gateway_allowance_key`（`alw_<UUID>`，與退款成功同一個 batch 由應用程式產生寫入、之後永不更改，非空、唯一）、`status`（`pending` 待折讓、`unknown` 結果不明、`failed` 明確失敗、`issued` 已折讓）、`allowance_number`、`issued_at`；每次嘗試留在 `allowance_attempts`（只增不改）。
- 原票未開立不折讓：義務綁定收款，退款先成功而原票尚未完成（待開立、失敗、結果不明）時，只保留退款與義務，**不向發票服務送出折讓**（不產生無原票的折讓）、也不阻擋退款；管理員在原票未開立時按補辦折讓回 `invoice_not_issued`。原票開立成功（含管理員補辦成功，`runInvoice`）時，同一個流程會對這筆收款上尚未折讓的義務逐筆折讓，不必有人手動；付款事件重送與退款轉為成功之後（`runRefund` 的 `finish`）也會觸發同一條路徑。
- 開立同款的補辦模式（比照 #121）：交易外呼叫、沒有 processing 租約；以冪等鍵加本地條件更新（`status <> 'issued'`，已折讓不可被蓋回）保證同筆退款只折讓一次，並行與重送回同一張折讓；結果不明先 `GET /v1/allowances/:allowanceKey` 查證再用同一個鍵送出；回應的鍵、原票鍵、金額與本站不符、409 `allowance_conflict` 一律當作結果不明並 log；明確失敗（`allowance_failed`、422 `allowance_exceeds_invoice`、其他 4xx）留待補辦。折讓成功時折讓通知（`allowance_issued`，折讓號碼、金額與原票號碼，內容固定）與狀態同一個 batch 寫入，之後才投遞；首次投遞遺失由管理員重寄（RPC `resendAllowance`，同一封信的新投遞，寄到顧客目前已驗證的 email）。RPC：`retryAllowance`、`resendAllowance`（輸入 `{ refundId }`）。
- 畫面：顧客訂單頁「發票」同時表達退款完成與憑證待補——還有未折讓的退款時標「憑證待補」且只顯示已折讓累計、**不給餘額**（不把未折讓的原額標成已結清）；全部折讓完成才顯示「折讓後餘額」（原額減累計折讓）。後台「發票待辦」的「憑證待補（待折讓）」清單列出所有未完成的折讓（結果不明在前）與嘗試紀錄，原票已開立的可補辦，否則標「等原票開立」；後台訂單頁「發票」表逐筆顯示折讓進度、號碼與補辦／重寄通知按鈕；手機與桌機皆可操作（e2e 驗證）。
- 模擬服務（`apps/gateway`，migration `0004_allowances.sql`）：`POST /v1/invoices/:invoiceKey/allowances`（`{ allowanceKey, amountTwd }`）、`GET /v1/allowances/:allowanceKey`，見「模擬金流閘道」；主控頁可切換「下一次折讓失敗」與「下一次折讓已成立但回應遺失」。
- 部署順序：先停止寫入，再套用 migration（App 的 `0031_allowances.sql` 與閘道的 `0004_allowances.sql`），然後部署閘道、App，最後 Web；0031 重建 `allowance_obligations`（要加 CHECK 與 NOT NULL 欄位），遷移前（0030）已存在的義務補成 `alw_legacy_<義務編號>`、狀態 `pending`，由原票已開立後的付款事件重送或管理員逐筆補辦折讓送出（沒有 Cron 與批次補送）。重點是先停止寫入：舊 App 在 migration 與新 App 上線之間讓退款轉成功時，那個 batch 會因 `gateway_allowance_key` NOT NULL 而整批失敗（退款狀態不寫回，維持處理中／不明），待新 App 上線後由管理員重試、先向閘道查證再補回，所以窗口期不會留下缺義務的成功退款；上節「安全網」的第二段補登 SQL 保留為保險，通常用不到。閘道 0004 只新增資料表、沒有回復腳本。
- 回復：先停止寫入並先回復 Web 與 App，再執行 `wrangler d1 execute <DB> --file apps/app/rollback/0031_allowances.down.sql`（只要有任何已折讓的義務、任何折讓嘗試紀錄——含結果不明，發票服務那邊可能已折讓——或原票已開立而冪等鍵不是 `alw_legacy_` 開頭的待折讓義務，守門檢查就讓回復失敗；其餘由成功退款推得，義務本身保留。殘餘風險：閘道已折讓成功、本地尚未記下任何嘗試的義務守門看不出來，回復後重新套用可能重複折讓，須先到閘道主控頁核對，與 #121 的 `inv_legacy_` 同理）。回復順序是 0031 → 0030 → …。
- 測試：`apps/app/test/allowances.test.ts`（自動折讓一次、退款先於原票、原票補辦後補折讓、重送與並行不重複、失敗與不明與查證與補辦、已折讓不被蓋回、通知重送、權限）、`allowances-migration.test.ts`（遷移補冪等鍵、約束與回復）、`apps/gateway/test/allowance.test.ts`、`apps/web/src/admin/invoice.test.ts`、`apps/web/src/orders/invoice.test.ts`、`e2e/tests/invoices.spec.ts`（手機與桌機）。

### 查找舊單、匯出與客服備註（#123）

依設計文件 Q23（Migration `0032_order_search_notes.sql`；`apps/app/src/orders/admin-queries.ts`、`apps/app/src/order-notes/`；Web 的 `/admin/orders` 與 `/admin/orders/export`）。後台訂單列表不再只有最新 200 筆：可依訂單編號、顧客 email 片段（不分大小寫）、狀態、成立日期區間（台北時間，含起訖兩天）查找，一頁 20 筆，以訂單編號游標往舊的翻頁（`listOrdersForAdmin` 的 `beforeId` 與回傳的 `nextBeforeId`），期間新增的訂單不造成重複或遺漏。

- 索引與參數：新增 `orders_status_idx (status, id)`、`orders_created_idx (created_at, id)`；email 先在顧客表找出符合的顧客，再以既有的 `orders_customer_idx` 對回訂單。條件全部參數化（email 用 `instr`，`%`、`_` 不當萬用字元），綁定參數數量固定，不隨筆數成長（D1 單句上限 100 個）。
- 匯出：`exportOrdersForAdmin` 與列表共用同一份條件與排序，每批至多 500 筆，Web 的 `/admin/orders/export`（GET，沿用列表網址參數）逐批取回、邊取邊串流，記憶體不隨訂單數成長；檔案為 UTF-8（含 BOM，Excel 直接開）、CRLF，每張訂單一列：成立時間、顧客、狀態、總金額、付款需要處理、已收款、已退款、各進度數量（訂購、已交運、已取消、已退貨、已遺失、物流退回）、已開立發票號碼、待折讓筆數。以 `=`、`+`、`-`、`@`、Tab、CR 開頭的文字前面補單引號（CSV injection）。第一批先取回再回應，未授權回 403、條件無效回 400；中途某批失敗讓串流出錯，下載中斷而不是留下缺資料的檔案。後續流程票新增的進度不由本票預先投影。
- 客服備註：`addOrderNote`（內容 trim 後 1–1000 字）寫入 `order_notes`（訂單、操作者 email、內容、時間），**只增不改不刪**由資料庫 trigger 保證（比照庫存流水）；更正請再加一則。備註只出現在管理 RPC `getOrderForAdmin` 的 `notes` 與後台訂單明細頁，顧客端 RPC 與畫面一律讀不到。其他重要管理操作的操作者、時間與原因沿用各自的紀錄（庫存流水、退款與發票嘗試、取消與退貨審核等），本票不另建稽核表。
- 權限：`listOrdersForAdmin`、`exportOrdersForAdmin`、`addOrderNote` 皆走 Access JWT，已加入 `rpc-surface` 白名單與 `admin-auth` 的拒絕測試。
- 回復：先停止寫入並先回復 Web 與 App，再執行 `wrangler d1 execute <DB> --file apps/app/rollback/0032_order_search_notes.down.sql`；已有任何客服備註時守門檢查讓回復失敗（備註是營運紀錄，須先匯出並確認可以捨棄）。回復順序是 0032 → 0031 → …。
- 測試見 `apps/app/test/admin-orders.test.ts`（查找、翻頁、匯出分批、備註與顧客隔離）、`order-notes-migration.test.ts`；Web 的解析與 CSV 在 `apps/web/src/admin/order-search.test.ts`、`orders-csv.test.ts`、`orders-export.test.ts`；手機與桌機的操作由 `e2e/tests/order-search.spec.ts` 驗證（375／1280 寬，含無障礙掃描）。

## 模擬金流閘道

`apps/gateway`（`@storefront/gateway`）是獨立的 Worker，自己的 D1，模擬「外部」金流閘道；本站只透過 HTTP API 與簽章 webhook 和它互動。本機以 `bun run dev:gateway` 啟動（`bun run db:migrate` 會一併套用它的 migration），設定見 `apps/gateway/.dev.vars.example`。

- Worker secrets（每個環境各設一次，於 `apps/gateway` 執行 `bunx wrangler secret put <名稱> --env <preview|production>`）：`GATEWAY_API_KEY`、`GATEWAY_WEBHOOK_SECRET`。缺少任一個時所有請求回 503（fail closed）。
- `apps/gateway/wrangler.jsonc` 各環境的 `routes` 網域與 D1 `database_id`（`REPLACE_WITH_` 開頭）部署前要填入；付款頁由顧客的瀏覽器直接開啟，所以需要自訂網域。

API（JSON，`Authorization: Bearer <GATEWAY_API_KEY>`；回應 `{ ok: true, data }` 或 `{ ok: false, error: { code, message, fields? } }`）：

| 路徑 | 說明 |
| --- | --- |
| `POST /v1/payments` | `{ merchantReference, amountTwd, returnUrl, webhookUrl, expiresAt? }` → 201 `{ paymentId, paymentUrl, expiresAt }`。10 分鐘後失效（`src/config.ts` 的 `PAYMENT_TTL_MS`）；可選的 `expiresAt`（epoch 毫秒，必須晚於現在，否則 400）讓付款最晚在那個時間失效，實際失效時間是兩者較早者 |
| `GET /v1/payments/:id` | `{ paymentId, status, amountTwd, merchantReference, expiresAt, eventId, refundedTwd }`；`status` 為 `pending / succeeded / failed / expired`（退款不改付款狀態）。`eventId` 是最近一個事件（成功／失敗）的 ID，與 webhook 的 `eventId` 相同，供導回查詢與 webhook 共用冪等鍵；沒有事件（pending、取消而失效）為 `null`。`refundedTwd` 是已成功退回的累計金額 |
| `POST /v1/payments/:id/cancel` | 讓進行中的付款失效：取消後狀態就是 `expired`（沒有獨立的 cancelled 狀態，也不產生事件）；已 `expired` 冪等成功，已有結果者 409 `payment_not_cancellable` |
| `POST /v1/payments/:id/refunds` | `{ refundId, amountTwd }` → 200 `{ refundId, paymentId, status: "succeeded", amountTwd }`。部分退款，以呼叫端給的 `refundId`（1–100 個英數、`_`、`-`）為冪等鍵：同一個 ID 已成功再送回同一筆結果、不重複退；明確失敗過的可用同一個 ID 重試。只有 `succeeded` 的付款可退（409 `payment_not_refundable`）；累計成功退款加這一筆超過付款金額回 409 `refund_exceeds_payment`；同一個 ID 帶不同金額或用在別筆付款回 409 `refund_conflict`；模擬的失敗回 502 `refund_failed`（款項不動）。不送 webhook |
| `POST /v1/invoices` | `{ invoiceKey, merchantReference, amountTwd }` → 200 `{ invoiceKey, invoiceNumber, merchantReference, amountTwd, issuedAt }`。開立模擬發票，以 `invoiceKey`（1–100 個英數、`_`、`-`）為冪等鍵：同一個鍵重送回同一張發票（同號碼）、不重複開立；同鍵不同金額或參照回 409 `invoice_conflict`；模擬的失敗回 502 `invoice_failed`（沒有開立，可用同一個鍵重試）；模擬的回應遺失回 504 `invoice_timeout`（發票已開立，呼叫端須查證） |
| `POST /v1/invoices/:invoiceKey/allowances` | `{ allowanceKey, amountTwd }` → 200 `{ allowanceKey, invoiceKey, allowanceNumber, amountTwd, issuedAt }`。對已開立的發票折讓，以 `allowanceKey`（1–100 個英數、`_`、`-`）為冪等鍵：同一個鍵重送回同一張折讓、不重複；同鍵不同金額或不同發票回 409 `allowance_conflict`；發票不存在回 404 `invoice_not_found`（不產生無原票的折讓）；累計折讓超過發票原額回 422 `allowance_exceeds_invoice`；模擬的失敗回 502 `allowance_failed`（沒有折讓，可用同一個鍵重試）；模擬的回應遺失回 504 `allowance_timeout`（折讓已成立，呼叫端須查證） |
| `GET /v1/allowances/:allowanceKey` | 查證一張折讓（同上形狀）；從未收過這個鍵回 404 `allowance_not_found` |
| `GET /v1/invoices/:invoiceKey` | 查證一張發票（同上形狀）；從未收過這個鍵回 404 `invoice_not_found` |
| `GET /v1/payments/:id/refunds/:refundId` | 查證一筆退款：`{ refundId, paymentId, status: "succeeded" \| "failed", amountTwd }`；閘道從未收過這個 ID 回 404 `refund_not_found`。呼叫端逾時、結果不明時先用它查，再決定要不要用同一個 ID 重送 |

付款頁 `GET /pay/:id`（免認證）讓顧客選成功／失敗、立即／延遲回呼、是否重複回呼、是否「不導回」（模擬顧客關閉視窗：不 303，只顯示「付款已完成，您可以關閉此頁」，搭配延遲回呼即可在瀏覽器重現遲到的付款成功），否則送出後 303 導回 `returnUrl?paymentId=...`。延遲回呼只記錄事件、不送；開發主控頁 `GET /console`（HTTP Basic，帳號任意、密碼為 `GATEWAY_API_KEY`）可對任一事件「立即送出」或「重送」，用來確定地重現遲到的付款成功與重複回呼。主控頁也能對每筆付款切換「下一次退款失敗」：切換後該筆付款的下一次退款嘗試回 502 `refund_failed`（那筆退款記為 `failed`，款項不動），旗標隨即消耗，以同一個 `refundId` 重試即成功；主控頁列出每筆付款的各筆退款。主控頁的「模擬發票」區可切換「下一次開立失敗」（502 `invoice_failed`、沒有開立）與「下一次開立已成立但回應遺失」（504 `invoice_timeout`、發票已開立），旗標用完即清，並列出最近開立的發票；「模擬發票折讓」區同樣可切換「下一次折讓失敗」與「下一次折讓已成立但回應遺失」，並列出最近的折讓。

Webhook：`POST <webhookUrl>`，本文 `{ eventId, type, paymentId, merchantReference, amountTwd, occurredAt }`（`type` 為 `payment.succeeded / payment.failed`；退款不送 webhook；`occurredAt` 是事件建立時間的 epoch 毫秒，重送不變）。Header `Gateway-Signature: t=<unix 秒>,v1=<hex(HMAC-SHA256(GATEWAY_WEBHOOK_SECRET, "<t>.<原始 body>"))>`，`t` 是每次投遞當下的時間。接收端用 `@storefront/gateway/webhook-signature` 的 `verifyWebhookSignature` 驗證（預設容忍 5 分鐘），並以 `eventId` 去重。

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

### 商品變體（預設變體與多變體）

依 [ADR 0005](docs/adr/0005-variants-own-price-and-stock.md)，可購買、定價與計算庫存的單位是商品變體（`product_variants`）。每個商品都有一個預設變體，由 Migration `0013_product_variants.sql` 從既有商品的售價、原價與在庫數轉成；新增商品時一併建立。商品保留名稱、說明、分類、圖片與上架狀態，不再有 `price_twd`、`compare_at_price_twd`、`on_hand`。選項維度與多變體見下一節（Migration `0014_variant_options.sql`）。

- 購物車、結帳與庫存調整都以變體編號為準：結帳明細帶 `variantId`，訂單明細同時記 `variant_id` 與 `product_id`（取封面、連結），後台庫存調整送 `variantId`。沒有選項的商品，列表帶 `defaultVariantId` 供直接加入購物車；有選項的商品要進詳情頁選變體（詳情回傳各販售中變體的價格與可售量）。被取代的以商品編號結帳的路徑已移除，瀏覽器購物車格式升到第 2 版，舊版購物車會被視為空（顧客需重新加入）。
- 此片當時沿用付款扣庫語意；#111 已改為付款保留、交運才扣庫，見下方「庫存保留與庫存流水」。
- 遷移保留歷史：舊明細逐筆指向該商品的預設變體，單價、數量、名稱快照與訂單總額原樣不動，所以實付金額與免運結果不變；對不到預設變體的明細會讓 `variant_id NOT NULL` 失敗、整個遷移中止，不會丟掉明細或編造對應。
- 部署順序沿用先 migration、再 App、再 Web，窗口內的影響：(1) migration 後、新 App 前，舊 App 的商品列表、結帳與付款事件 SQL 會因 `products.price_twd`／`on_hand` 不存在而失敗，這段時間顧客無法瀏覽與結帳，付款事件套用也會失敗；(2) 新 App 上線、新 Web 未上線時，舊 Web 以 `productId` 結帳、以 `{ id }` 調庫存，會被驗證擋下回 `invalid_input`（不會寫入）。建議把兩個窗口壓到最短，並在 migration 前暫停後台庫存與商品操作。
- 窗口內付款事件的補救：付款事件套用失敗時，付款與訂單都不會被改動。依據是閘道的事件本文在建立時固定、投遞紀錄存檔，且 `apps/gateway/src/transitions.ts` 註明可由閘道主控頁重送，程式內沒有自動重試；顧客被導回 `/orders/:id/payment-return` 時 App 也會主動向閘道查詢一次。補救順序：新 Web／App 都上線後，先到閘道主控頁查看窗口期間各事件的投遞結果，對失敗的事件重送（套用以事件 ID 去重，重送安全）；若主控頁查不到該事件或重送仍失敗，再人工以該事件的內容重放 webhook，並對照訂單與付款狀態確認。人工重放的步驟與權限尚無既有文件，需事前另行確認。
- 回復：套用後若要退回，先停止寫入，再執行 `wrangler d1 execute <DB> --file apps/app/rollback/0013_product_variants.down.sql`（加 `--local`／`--remote`／`--env`）；它把預設變體寫回 `products`、明細改回只指向商品、移除 `d1_migrations` 紀錄。只在每個商品都恰好一個預設變體時可用，否則守門檢查會讓回復失敗。回復前須一併回復 Web、App 與 E2E 呼叫端（購物車格式與結帳輸入都已變更）。測試見 `apps/app/test/product-variants-migration.test.ts`。

#### 選項維度、多變體與停賣

管理員在商品編輯頁（`/admin/products/:id`「選項與變體」）設定最多兩個選項維度（名稱，例如「尺寸」「顏色」），並只建立實際販售的組合；每個變體各有選項值、售價、原價與在庫數（庫存仍只能增減），可指定同商品圖庫中的一張圖片，也可停賣或恢復販售。對應 RPC：`setProductOptions`、`createVariant`、`updateVariant`、`setVariantDiscontinued`（皆需 Access JWT），庫存沿用 `adjustStock`。資料在 Migration `0014_variant_options.sql`：`products.option1_name`／`option2_name`、`product_variants.option1_value`／`option2_value`／`discontinued_at`／`image_id`，以及 `order_lines.variant_label`。

- 沒有選項的商品維持一個預設變體（選項值為空字串）；設了選項後預設變體取得選項值。同商品的選項值組合不可重複（唯一索引），選項值個數必須等於維度個數（寫入的同一句檢查）。維度個數只有在商品僅有一個變體時才能增減，已有多個變體只能改維度名稱。
- 停賣的變體不能被購買：結帳的條件寫入排除它，回報 `discontinued`；它不出現在詳情頁、列表價格範圍、有貨篩選與特價判定，仍留在後台與歷史訂單。全部變體停賣的商品列表顯示「已停賣」且沒有報價，詳情頁不顯示價格與購買表單。
- 結帳再次驗證價格（`price_changed`）、停賣（`discontinued`）與可售量（`insufficient_stock`），逐變體判定，同單不同變體不合併、不共用庫存。訂單明細快照變體選項（`variant_label`，例如「120 公分 / 胡桃色」），之後改選項值或停賣不影響既有訂單。
- 列表價格是販售中變體的範圍；有選項的商品只標示「有特價選項」，不顯示單一劃線價。圖庫仍最多 8 張、第一張為封面；刪除圖片時指定它的變體一併改回不指定。`product_variants.image_id` 沒有外鍵（外鍵會讓回復遷移必須重建資料表），「圖片屬於同一商品」由 `updateVariant` 在寫入的同一句檢查。
- 部署順序沿用先 migration、再 App、再 Web。0014 只新增欄位與索引，舊 App 不受影響；新 App 搭配舊 Web 時，商品詳情回傳的欄位已改為 `variants`，舊詳情頁會顯示不出價格，應壓短窗口。
- 回復：先停止寫入，再執行 `wrangler d1 execute <DB> --file apps/app/rollback/0014_variant_options.down.sql`；只在尚未使用任何新功能（沒有選項、選項值、停賣、指定圖片與明細選項快照）時可用，否則守門檢查讓回復失敗。要連 0013 一起回復，接著執行 0013 的回復腳本。測試見 `apps/app/test/variant-options-migration.test.ts`。
- 購物車行加上選項標籤 `label`（選填，僅顯示用），仍是第 2 版格式。手機與桌機的選取與操作由 `e2e/tests/variants.spec.ts` 驗證（375／1280 寬，含無障礙掃描），選取邏輯的單元測試在 `apps/web/src/catalog/variant-picker.test.ts`。

#### 尺寸、材質與保養資訊

管理員在商品編輯頁（`/admin/products/:id`「基本資訊」）維護純文字的尺寸、材質與保養（各至多 2000 字，可留空）。`updateProduct` 的 `dimensions`／`material`／`care` 不帶表示不動、帶空字串表示清空；商品詳情（`getProduct`）與後台（`getProductForAdmin`）回傳這三欄。顧客在商品頁看到「尺寸、材質與保養」區塊，沒填的項目不顯示、全沒填則整個區塊不出現；它們是商品層級資訊，不隨變體變動，也不併入列表。資料在 Migration `0015_product_info.sql`（`products.dimensions`／`material`／`care`，預設空字串）。價格範圍、特價選項與有貨篩選沿用 `0014` 的規則（只計販售中變體）。

- 部署順序沿用先 migration、再 App、再 Web；0015 只新增欄位，舊 App 與舊 Web 不受影響（舊 Web 只是不顯示、也不送出這三欄）。
- 回復：先停止寫入，再執行 `wrangler d1 execute <DB> --file apps/app/rollback/0015_product_info.down.sql`；三欄有任何內容時守門檢查讓回復失敗。測試見 `apps/app/test/product-info.test.ts`、`apps/app/test/product-info-migration.test.ts`，手機與桌機的操作由 `e2e/tests/product-info.spec.ts` 驗證（含無障礙掃描）。
