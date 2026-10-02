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
- 尚未涵蓋（後續票）：取消審核、配送異常、退貨審核、退款結果、發票完成等通知。

## 地址簿

顧客在 `/account/addresses` 保存、修改、刪除自己的收件資訊（姓名、電話、地址，欄位規則同結帳；每人上限 10 筆），結帳頁（`/checkout`）的「使用地址簿」下拉選單把選中的內容帶入收件欄位，送出前仍可修改。訂單的收件資訊是送出當下表單內容的快照（`orders.shipping_*`），不引用地址簿，之後修改或刪除地址都不影響既有訂單。地址簿 RPC（`listMyAddresses`、`addAddress`、`updateAddress`、`deleteAddress`）一律由 cookie 換顧客身分並以該顧客為條件，別人的地址編號與不存在的編號同樣回 `address_not_found`；未登入回 `unauthorized`。資料在 Migration `0017_address_book.sql`（`customer_addresses`），只新增資料表，部署順序沿用先 migration、再 App、再 Web，舊 App 與舊 Web 不受影響。

- 回復：先停止寫入，再執行 `wrangler d1 execute <DB> --file apps/app/rollback/0017_address_book.down.sql`；表內已有地址時守門檢查讓回復失敗（顧客保存的地址會消失，訂單上的快照不受影響），須先確認可以捨棄。回復前須一併回復呼叫這些 RPC 的 Web 與 App。
- 測試見 `apps/app/test/address-book.test.ts`、`address-book-migration.test.ts`；手機與桌機的操作（含顧客隔離、結帳選用與舊單不變）由 `e2e/tests/address-book.spec.ts` 驗證（375／1280 寬，含無障礙掃描）。

## 配送類型與運費

台灣本島限定，兩種配送類型：一般宅配與大型配送（`apps/app/src/shipping/types.ts` 的 `DELIVERY_TYPES`）。配送類型設在商品變體（`product_variants.delivery_type`，預設一般宅配）：沒有選項的商品在商品編輯頁的主表單設定，有選項的商品在「選項與變體」的各變體卡片設定；新增商品與新增變體也可指定。費率在 `/admin/shipping`（RPC `getShippingRates`、`setShippingRate`，需 Access JWT），初始演練值一般 NT$100、大型 NT$600，可調為 0（該類型免運）。

- 計費：一張訂單裡含某類型的變體就收該類型費率一次，混合兩類各收一次，同類不按件數或明細數加收；商家日後分批出貨不追加。總額 `orders.total_twd` = 商品小計 + 兩類運費，付款金額與下單通知信件都用它，三者一致。
- 快照：訂單把成立當下各類實收運費寫進 `orders.standard_shipping_fee_twd`、`large_shipping_fee_twd`（沒有該類型為 0），明細把配送類型寫進 `order_lines.delivery_type`，連同商品名、選項、實付單價與收件資訊都不隨之後的改價、改費率或改類型而變。#112（分批出貨）、#115（異常退款）、#116（部分取消退運費）從這幾個欄位讀取。
- 顧客確認：購物車只在瀏覽器，結帳頁向 `GET /api/shipping-quote?variants=…`（App 的公開 RPC `getShippingQuote`）取得現行費率與各變體的配送類型，列出兩類運費與總額、說明限台灣本島並要求勾選確認；送出時帶 `seenShippingTwd`（顧客確認的運費合計），App 在下單 batch 內以當下的費率與類型重算並比對，不符就整批不成立並回 `shipping_fee_changed`（與價格變動同樣由重新載入的結帳頁讓顧客再確認）。查不到運費時結帳頁停用送出鈕。
- 下單 batch 的語句數與順序不變（#109 的通知信仍是第 4 句）：運費由訂單本體那句用 `json_each` 子查詢算出並寫入，明細那句的 WHERE 加上「運費合計 = 顧客確認的金額」；兩句在同一個 batch 讀同一份資料。冪等鍵的內容指紋含 `seenShippingTwd`。
- 舊單：Migration `0019_shipping_fees.sql` 對既有訂單的兩個運費欄位預設 0、明細預設一般宅配，所以歷史訂單的總額與免運結果不變；寫入初始費率兩列。新增欄位未加 CHECK（drizzle-kit 的 `check()` 是表層級約束，產生的遷移會重建資料表），合法值由管理 RPC 的輸入驗證限定；`shipping_rates` 有 CHECK。
- 部署順序沿用先 migration、再 App、再 Web。舊 App 搭配新 migration 仍可運作（欄位都有預設），但新 App 的結帳要求 `seenShippingTwd`，所以舊 Web 的結帳頁在新 App 上會被拒（回 `invalid_input`），Web 與 App 應壓短窗口一起部署。回復：先停止寫入，再執行 `wrangler d1 execute <DB> --file apps/app/rollback/0019_shipping_fees.down.sql`；已有訂單收過運費、或有大型配送的變體／明細時守門檢查讓回復失敗（總額含運費卻會失去拆分），須先確認可以捨棄。回復前須一併回復 Web 與 App；順序是 0019 → 0018 → …。
- 測試見 `apps/app/test/shipping-fees.test.ts`（計費、快照、金額一致、權限、輸入驗證）、`shipping-migration.test.ts`；Web 的試算與表單轉換在 `apps/web/src/checkout/shipping.test.ts`；手機與桌機操作由 `e2e/tests/shipping-fees.spec.ts`（混合結帳與後台）與 `shipping-rates.spec.ts`（調整費率不改舊單、非管理員 403；費率是全域狀態，獨立成最後執行的 project）驗證。

## 庫存保留與庫存流水

依 [ADR 0006](docs/adr/0006-physical-stock-deducted-on-dispatch.md)：可售 = 在庫數 − 不可售 − 待付款保留 − 已付款待出貨保留（不可售目前恆為 0，由退貨入倉檢查票（#117／#120）加入；`apps/app/src/catalog/stock.ts`），保留由訂單狀態推導（待付款、已付款與部分出貨訂單中「尚未交運」的明細數量，即明細數量減各批已交運數量，沒有另外的保留表）。

| 事件 | 在庫數 | 保留 | 可售 |
| --- | --- | --- | --- |
| 下單 | 不變 | + 待付款保留 | − |
| 付款成功（含遲到付款重新保留，ADR 0001） | 不變 | 待付款轉已付款，總量不變 | 不變 |
| 逾期、取消 | 不變 | 釋放 | + |
| 交運一批（`shipOrder`） | − 該批數量 | 消耗該批的已付款保留 | 不變 |
| 庫存調整 | ± | 不變 | ± |

- 付款 batch（`payments/queries.ts` 的 `applyPaymentEvent`）不再扣庫，原本的第 3 句（扣在庫數）已移除，結果索引由尾端倒數取值所以不受影響；交運（`shipments/dispatch.ts` 的 `dispatchShipment`）每批一個 batch：建立批次、寫批次明細、扣在庫、寫流水、轉訂單狀態、寫出貨通知，細節見下一節。
- 庫存流水（`stock_movements`，Migration `0020_stock_ledger.sql`）：在庫數的每一次變動，只增不改不刪，記來源（`adjustment` 調整、`dispatch` 交運、`migration` 遷移加回）、增減量、調整後在庫數、訂單、操作人（管理員 email）、原因與有效時間。流水與改動在庫數的那句同一個 batch、同一個條件寫入，被拒絕的調整不留紀錄。保留的變化（下單、付款、逾期、取消）可由訂單推導，不重複寫入流水。後續票（#124 低庫存提醒）讀這張表，新增來源（退貨入倉、報廢）時加新的 `kind`；`kind` 沒有 CHECK，合法值由寫入端限定。
- 庫存調整現在必填原因（`adjustStock` 的 `reason`，trim 後 1–200 字）；後台商品列表與變體表單都有原因欄位。唯讀 RPC `listStockMovements`（可依變體或訂單篩選，以 `nextBeforeId` 游標翻頁）與後台「庫存流水」頁（`/admin/stock-movements`，訂單明細頁有連結）供核對。
- 舊資料遷移（Q22 保留式遷移）：舊系統在付款時就扣了在庫數，`0020` 對每張狀態為「已付款」的舊單，逐單逐變體把數量加回在庫數並寫一筆 `migration` 流水；已出貨的不加回；因為已付款本身就是保留，可售量不變。遷移只信訂單狀態、不編造物流證據。套用後執行 `wrangler d1 execute <DB> --file apps/app/scripts/verify-0020-stock.sql`（加 `--local`／`--remote`／`--env`）核對例外，每個查詢回傳的列都需要人工處理，全為空才算通過：已付款卻沒有成功付款紀錄、可售為負、流水與在庫數對不上。
- 部署順序：**先停止寫入（結帳、付款、出貨、庫存調整）**，再 migration、再 App、再 Web。舊 App 搭配新 migration 會多出可售量（舊 App 不把已付款算進保留，加回的數量變成可售）；新 App 搭配舊資料則會在出貨時再扣一次，所以兩者之間不要放行流量。
- 回復：先停止寫入並先回復 App，再執行 `wrangler d1 execute <DB> --file apps/app/rollback/0020_stock_ledger.down.sql`。它把目前每張已付款訂單的數量從在庫數扣回（回到付款扣庫語意，涵蓋遷移前的舊單與遷移後才付款的新單），移除流水與遷移紀錄。守門檢查讓回復失敗的情況：流水裡有遷移以外的紀錄（調整與交運紀錄一旦移除就無法稽核），或扣回後在庫數會小於 0；須先確認這些資料可以捨棄或人工處理。回復順序是 0020 → 0019 → …。
- 測試見 `apps/app/test/stock-ledger.test.ts`（付款不扣庫、交運扣庫與流水、重複與並行出貨、已付款保留擋住調整、原因必填、查詢與權限）、`stock-ledger-migration.test.ts`（遷移、核對腳本、回復與守門檢查），遲到付款與逾期釋放沿用 `payment-late-success.test.ts`、`expiry.test.ts`；Web 的篩選解析在 `apps/web/src/admin/stock-form.test.ts`，手機與桌機的操作（含顧客不能進入）由 `e2e/tests/stock-ledger.spec.ts` 驗證（375／1280 寬，含無障礙掃描）。

## 分批出貨與大型配送預約

依 [ADR 0006](docs/adr/0006-physical-stock-deducted-on-dispatch.md)，管理員按明細數量交運多個**出貨批次**（Migration `0021_shipments.sql`；`apps/app/src/shipments/`）。

- 資料：`shipments`（訂單、冪等鍵 `dispatch_key`、物流單號、議定時段 `appointment_start`／`appointment_end`、交運時間、操作人，只增不改）與 `shipment_items`（批次明細：訂單明細、數量）。配送進度與送達時間由 0022 加在批次上（見下一節），#116（部分取消）、#118（依各批送達日退貨）同樣以批次為單位延伸；配送類型取自明細快照（`order_lines.delivery_type`），不在批次上重複。`orders.tracking_number`、`shipped_at` 已移除，一律讀批次。庫存流水新增 `shipment_id`（每批交運的流水指向該批；0021 之前的舊流水為空）。
- 訂單狀態新增「部分出貨」（`partially_shipped`）：至少交運過一批、仍有明細未出完；每筆明細都出完才轉「已出貨」。轉換表見 `orders/transitions.ts`。未交運的數量仍是已付款保留（`catalog/stock.ts`），所以交運只減在庫與保留各一次，可售數量不變；並行的庫存調整不能把可售壓到負數。
- 交運（`shipOrder`，輸入 `orderId`、`dispatchKey`、`items: [{ orderLineId, quantity }]`、選填 `trackingNumber`、`appointment: { start, end }`）是單一 batch：建立批次的條件是訂單此刻為已付款或部分出貨、同一冪等鍵還沒有批次、且每筆明細「已交運＋本批」不超過明細數量；其後的批次明細、扣在庫、流水、狀態轉換、出貨通知都只在批次存在且還沒扣過庫時執行。並行的兩次交運，先落地者贏，後者回 `shipment_quantity_exceeded`（或訂單已出完時 `order_not_shippable`）；同一冪等鍵重送回原批次（`replayed: true`；內容與原批次不同回 `dispatch_key_conflict`，比對 `shipments.request_hash`），不重複扣庫、不寫第二筆流水、不寄第二封信。取消申請（#116）要與交運競爭同一數量，就用同一個條件（明細數量減已交運數量）在自己的 batch 裡落地，以落地順序為準。
- 大型配送：批次含大型配送明細時必填議定時段（`appointment_required`），只含一般宅配時不可填（`appointment_not_applicable`）；時段只是記錄（UTC epoch 毫秒，網頁表單以台北時間輸入），不做司機容量排程。分批不追加運費，`orders.total_twd` 與兩類運費快照不變。
- 舊資料：0021 為每張舊的已出貨訂單補一批整單批次（`dispatch_key = 'legacy:0021'`，輸入驗證產生不出這個鍵、且內容指紋 `request_hash` 為空，所以重送交運永遠不會對舊批次再扣庫或寄信），物流單號與出貨時間照搬舊欄位，舊單沒有的出貨時間、預約留空，不編造；那些訂單在 0020 之前就已扣庫，補建批次不動庫存也不寫流水。orders 為了放寬狀態 CHECK 與移除舊欄位而重建（D1 不能關外鍵，改用備份、砍表、建表、寫回，並還原 AUTOINCREMENT 計數）。
- 通知：每批在同一個 batch 寫一封 `shipment_dispatched`（`event_key = shipment:<批次編號>`），交運後立即投遞，投遞失敗不影響交運，出現在 `/admin/mail` 待處理，重送同一批時補首次投遞。
- 畫面：管理員訂單頁「交運一批」表單（每筆未交運明細一個數量欄，預設為全部未交運數量；物流單號；大型配送議定時段）與「出貨批次」清單；顧客訂單頁與我的訂單列出各批的商品數量、物流單號與議定時段。
- 部署順序：先停止寫入（交運），再 migration、再 App、再 Web；舊 App 不認得 `partially_shipped` 與批次。回復：先停止寫入並先回復 App，再執行 `wrangler d1 execute <DB> --file apps/app/rollback/0021_shipments.down.sql`（會把整單批次搬回舊欄位；有部分出貨的訂單或遷移之後才建立的批次時守門檢查讓回復失敗，須先確認這些資料可以捨棄）。回復順序是 0021 → 0020 → …。
- 測試見 `apps/app/test/admin-ship.test.ts`（整批與分批交運、超量、冪等重送、並行、預約、通知、可見範圍與權限）、`shipments-migration.test.ts`（補建舊批次、重建 orders、回復與守門檢查）；Web 的表單解析在 `apps/web/src/admin/order-form.test.ts`，手機與桌機的操作由 `e2e/tests/shipments.spec.ts` 驗證（375／1280 寬，含無障礙掃描）。

## 追蹤送達與失敗後再次配送

每批各自追蹤配送進度（Migration `0022_shipment_delivery.sql`；`apps/app/src/shipments/events.ts`）。物流是模擬服務：管理員在訂單頁的批次清單「記錄物流回報」（RPC `recordShipmentEvent`，輸入 `shipmentId`、物流給的事件識別 `eventKey`、種類 `delivered`／`delivery_failed`／`redelivery`、發生時間 `occurredAt`）。

- 資料：`shipment_events`（只增不改的對帳紀錄，同一批同一 `event_key` 只有一筆；發生時間 `occurred_at` 與系統記錄時間 `recorded_at` 分開存）；`shipments.delivery_status`（`in_transit`／`delivery_failed`／`delivered`，預設 `in_transit`）與 `shipments.delivered_at`（實際送達時間，逐批記錄，#118 依各批送達日讀它）。進度不接受直接寫入，每次記錄回報都由該批全部事件重新推導，不看到達順序：有送達回報就是已送達（終點），送達時間取發生最早的一筆；否則依發生時間最新的回報，配送失敗 → `delivery_failed`，再次配送或沒有回報 → `in_transit`。所以延遲、重送、亂序都不會偽造送達或打回已確定的進度；已送達後才到的失敗或再次配送回報只留紀錄。
- 再次配送是同一批原貨再交付：不建新批次、不新增出貨數量、不扣庫、不退款（暫時失敗後送達無退款，設計文件 Q25），也因此不碰 `request_hash` 不變式。物流退回與確認遺失屬 #117／#119，退回入倉檢查屬 #120，不在這裡。
- 驗證：發生時間須不早於該批交運時間（有的話）、不晚於現在，否則 `event_time_invalid`；批次不存在 `shipment_not_found`；同一事件鍵帶不同內容 `event_key_conflict`。同鍵同內容重送回 `replayed: true`。舊批次（0021 補建）沒有可靠送達日，維持運送中、`delivered_at` 為空，不編造。
- 通知（沿用 #109 outbox，與回報同一個 batch 寫入）：送達通知 `shipment_delivered`（一批一封，`event_key = shipment_delivered:<批次編號>`；信件記載寫信當下的送達時間，之後才到的較早送達回報會更新 `delivered_at`，但不改寫已寄出的信）、配送異常通知 `shipment_delivery_failed`（一次失敗回報一封，`event_key = shipment_delivery_failed:<批次編號>:<回報事件鍵>`；只在該批未送達、且它是發生時間最新的回報時才寄，已送達後才到或已被後續回報取代的失敗回報不寄）；再次配送不寄信。投遞失敗不影響記錄，出現在 `/admin/mail` 待處理，可重送。
- 查證與補齊：管理員訂單頁每批的「物流回報」列出事件與其通知是否存在：`noticeExpected`（與寫信同一條件）為真而 `noticeMessageId` 為空才標「通知缺漏」，不該寄的（再次配送、已被取代或已送達）顯示「不寄信」；通知遺失時按「補齊通知」以同一事件重送，補回信件且不產生第二封。顧客訂單頁與我的訂單顯示各批配送進度與實際送達時間（顧客路徑不查物流回報）。表單回報時間精度到秒。
- 回復：先回復 App，再執行 `wrangler d1 execute <DB> --file apps/app/rollback/0022_shipment_delivery.down.sql`（已有任何物流回報或已送達批次時守門檢查讓回復失敗，須先確認可以捨棄）。回復順序是 0022 → 0021 → …。
- 測試見 `apps/app/test/shipment-delivery.test.ts`（送達、失敗後再次配送、亂序／重送／通知遺失、時間與衝突、權限）、`shipment-delivery-migration.test.ts`；Web 表單解析在 `order-form.test.ts`，手機與桌機操作由 `e2e/tests/shipment-delivery.spec.ts` 驗證。

## 付款

顧客在訂單頁按「前往付款」→ App 向閘道建立付款 → 導向閘道付款頁；結果由兩條路徑確認，共用同一個冪等的「套用付款結果」（以閘道事件 ID 去重）：閘道 webhook（Web 的 `POST /api/payments/webhook`，驗簽後轉給 App）為主，顧客被導回 `/orders/:id/payment-return?paymentId=…` 時 App 再主動向閘道查詢一次。付款成功依訂單當下的狀態分流（都只由搶到事件 ID 的那次呼叫執行一次）：待付款轉已付款；已逾期則在同一個 batch 內以條件式語句「重新保留」庫存（每一筆明細的可售數量都夠才轉為已付款（轉為已付款保留，不動在庫數），全有全無），見 ADR 0001；重新保留不到、落在已取消的訂單、或同一張訂單的第二筆成功付款，則付款記為成功、訂單不動，並在 batch 之外向閘道退款。退款結果記在付款上：狀態 `refunded`／`refund_failed`、原因 `late_success_unreclaimable`／`cancelled_order`／`duplicate_success`、時間。退款失敗只記錄與結構化 log（`payment_refund_failed`），不自動重試，管理員之後在後台處理；閘道退款是冪等的。

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
