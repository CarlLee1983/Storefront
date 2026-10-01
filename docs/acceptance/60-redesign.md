# 前台改版第二輪驗收（#60 / #48）

## 自動化證據

`bun run e2e` 以正式建置的 Web、真的本機 Worker、隔離的 D1／R2 與模擬金流閘道執行；CI 的 `e2e` job 跑同一個指令，並上傳 Playwright 報告與失敗時的 trace。

### 主流程（`e2e/tests/main-flow.spec.ts`）

主流程是單一個連貫的測試，放在獨立的 `main-flow` project，排在其他 project 全部跑完之後才執行：它會建立分類、上架 25 件商品、標原價與精選，會讓 `sale` 的「沒有特價商品」與首頁精選名額失準（見 `e2e/playwright.config.ts`）。它只依賴自己建立的資料。

1. 管理員在後台建立分類，並在分類頁上傳分類圖片；同分類以後台表單上架 24 件陪襯商品（部分售完）。
2. 管理員新增商品、選分類、補貨；沒有圖片時上架被拒；上傳圖片（失敗重試、回應遺失後不重複、多張一次上傳）；填原價後上架，再標為精選。
3. 顧客（桌機）在首頁精選區看到劃線價與折扣標籤，進詳情頁後從麵包屑回分類頁；也從首頁分類方塊（有分類圖片）與導覽列進入同一個分類頁。
4. 分類頁：預設新上架時這件商品排第一；改為價格高到低後不在第一頁，載入更多後出現、顯示 25 / 25 件，重新整理後排序與已載入數量都還原；開啟只看有貨後售完商品消失（21 件），再開啟只看特價只剩這件，重新整理後兩個開關都還在。
5. 從 header 搜尋（小寫輸入），結果頁有這件商品，點進詳情頁。
6. 從導覽列進入特價頁，看到這件商品的劃線價與標籤。
7. 之後沿用 #37 的購買路徑：全部商品頁的封面（WebP、多尺寸、immutable 快取）、鍵盤進入詳情、圖庫鍵盤切換、加入購物車的 toast、購物車、結帳、閘道付款成功（真實簽章 webhook 與導回查詢）、管理員出貨、顧客的訂單列表與詳情顯示已出貨與物流單號。

### 其他規格的涵蓋

- 手機選單的焦點管理與 Esc 關閉：`e2e/tests/visual-shell.spec.ts`（焦點移入抽屜、Esc 關閉後焦點回到選單按鈕）。
- 沒有分類時上架被拒絕：`e2e/tests/categories.spec.ts`（顯示「請先選擇商品分類」）。

### axe（零違規，沒有排除任何規則）

| 頁面 | 規格 |
| --- | --- |
| 首頁 | `accessibility.spec.ts`（320／768／1280px）、`homepage.spec.ts`（390／1280px） |
| 全部商品 | `listing.spec.ts`、`main-flow.spec.ts` |
| 分類頁 | `categories.spec.ts`、`listing.spec.ts`、`main-flow.spec.ts`（排序與篩選後） |
| `/sale` | `sale.spec.ts`、`main-flow.spec.ts` |
| `/sale` 空狀態 | `sale.spec.ts` |
| 搜尋結果 | `search.spec.ts`、`main-flow.spec.ts` |
| 搜尋沒有結果 | `search.spec.ts` |
| 商品詳情 | `main-flow.spec.ts`、`product-detail.spec.ts`、`detail-cart-redesign.spec.ts`、`sale.spec.ts` |
| 購物車、結帳 | `main-flow.spec.ts`、`accessibility.spec.ts`、`cart-checkout-redesign.spec.ts` |
| 訂單列表 | `main-flow.spec.ts`、`accessibility.spec.ts`、`orders-redesign.spec.ts` |
| 訂單詳情 | `main-flow.spec.ts`（待付款、已付款、已出貨；320／768／1280px） |
| 關於、常見問題、退換貨說明、404 | `main-flow.spec.ts`、`accessibility.spec.ts` |
| 打開的手機選單 | `visual-shell.spec.ts` |

### 本機執行紀錄

2026-10-01 在 owner 的 MacBook Air M4 上：`bun run e2e` 時 `product-detail.spec.ts` 的手機滑動斷言失敗（#67 記錄的本機不穩定；main 最近 8 次 CI，例如 run 36881451337，都是成功），依賴 `chromium` 的 project 因此全部沒跑。改以 `playwright test --no-deps --workers=1 --grep-invert "public detail gallery"` 依設定檔順序單一行程執行，51 個測試全部通過，`main-flow` 在最後。**這次本機執行排除了 `product-detail.spec.ts`**（它只有這一個測試），上表引用它的詳情頁 axe 由 CI 執行；詳情頁在本機仍由 `main-flow`、`detail-cart-redesign`、`sale` 的 axe 涵蓋。CI 上的結果以 PR 的 `e2e` job 為準。

`main-flow` 依賴其他所有 project：前面任一 project 失敗時它不會執行，而會顯示為沒有跑（did not run），不會被當成通過。

## Lighthouse（手機模式，preview，手動量測，不放進 CI）

- 量測時間：2026-10-01T15:21Z–15:22Z（UTC）。
- 環境：preview（`https://storefront-preview.gravito.dev`），部署的 commit 為 `9006075`（main，#71 合併後的 Deploy run 36881451480 成功，2026-10-01T15:04Z 開始）。這次之後沒有改動任何 Worker 程式碼。
- 資料：#59 的 seed 灌入的示範資料，4 個分類、32 件商品全部上架。
- 工具：Google Chrome 154.0.8037.92、Lighthouse 13.5.0 CLI，以 `--port` 連到同一個 Chrome 設定檔（Playwright persistent context）；Navigation 模式、`--form-factor=mobile`、預設的模擬節流、只量 Performance 與 Accessibility、`--disable-storage-reset`，讓購物車的 localStorage 留著。
- 購物車：在同一個設定檔的詳情頁按「加入購物車」放入 Luma 弧形單椅。報告的最後畫面是**數量 2**：前兩次執行在量測前中止（第一次是腳本的按鈕定位錯誤，沒有點到；第二次已加入購物車，但 Lighthouse 在首頁導覽時因為分頁被 Playwright 卡住而失敗，沒有產生任何報告），第三次又加了一次。中止的兩次都沒有產生報告，沒有捨棄任何分數。
- 每份報告的最後網址都是預期的頁面；購物車報告的最後畫面有商品與封面。

| 頁面 | 最後網址 | Performance | Accessibility | 報告 |
| --- | --- | --- | --- | --- |
| 首頁 | `/` | 99 | 100 | [HTML](lighthouse-60/home.report.html) / [JSON](lighthouse-60/home.report.json) |
| 商品詳情（3 張圖） | `/products/2` | 100 | 100 | [HTML](lighthouse-60/detail.report.html) / [JSON](lighthouse-60/detail.report.json) |
| 購物車（1 種商品） | `/cart` | 100 | 100 | [HTML](lighthouse-60/cart.report.html) / [JSON](lighthouse-60/cart.report.json) |
| 分類列表 | `/categories/living` | 100 | 100 | [HTML](lighthouse-60/category.report.html) / [JSON](lighthouse-60/category.report.json) |
| 搜尋結果 | `/search?q=luma` | 100 | 100 | [HTML](lighthouse-60/search.report.html) / [JSON](lighthouse-60/search.report.json) |

五頁的 Performance 與 Accessibility 都 ≥ 90。每頁只量一次，沒有重跑。
