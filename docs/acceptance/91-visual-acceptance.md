# 前台視覺驗收（#91 / #76）

狀態：截圖與 Lighthouse 已完成；**owner 視覺核可待完成**。實作 #85–#90 已合併，驗收附件不修改應用程式。

[畫面審閱頁（縮圖與完整 PNG）](91-assets/review.html) · [量測 manifest](91-assets/public-manifest.json) · [附件 SHA-256](91-assets/sha256.json)

## 版本與環境

2026-10-02T07:10:54Z–07:12:23Z，正式建置的本機 E2E harness、隔離 D1／R2、4 個分類與 32 件上架示範商品。使用既有 E2E 假會員與簽章 session，經顧客 UI 及模擬閘道建立已付款訂單 `/orders/1`，再將購物車補回 Luma 弧形單椅、數量 2。沒有複製 owner 的憑證或瀏覽器設定檔，也沒有新增正式環境的驗證入口。

擷取提交 `0f3aa241e1fd391c674c1fa66e6759fa3fc3f735`，已以 `git diff --quiet` 確認與合併後 main `9c0c160972d42cf18fcd87ac1893d21fc368d321` 的完整追蹤檔案一致。

Chrome 154.0.8037.93、Lighthouse 13.5.0、Node 24.21.0、Bun 1.4.2。Lighthouse 為 Navigation、mobile、模擬節流，只量 Performance／Accessibility；以 `--port` 連到隔離 Chrome，`--disable-storage-reset` 保留購物車與測試會員。Playwright 在 Lighthouse 執行前斷開，沒有同時操作分頁。每頁量一次，所有產生的分數都保留，沒有挑選分數。

初次前置檢查使用舊的商品數量文字，於資料操作與 Lighthouse 前中止，修正腳本後完成此次擷取。保留 [中止紀錄](91-assets/stopped-preflight.json)；沒有捨棄任何 Lighthouse 報告。Chrome 設定檔、測試 cookie 與內部 log 不納入附件。

## 375／1280 截圖

共 18 張完整頁面截圖；375 的 viewport 為 375×812，1280 為 1280×900。等待字型及商品圖片完成，首頁固定第一張輪播；每張都對整頁執行水平溢出檢查與 axe，全部 **無溢出、零違規**，沒有排除 axe 規則。

| 頁面 | 375 | 1280 |
| --- | --- | --- |
| 首頁 | [PNG](91-assets/home-375.png) | [PNG](91-assets/home-1280.png) |
| 分類 | [PNG](91-assets/category-375.png) | [PNG](91-assets/category-1280.png) |
| 詳情 | [PNG](91-assets/detail-375.png) | [PNG](91-assets/detail-1280.png) |
| 有商品的購物車 | [PNG](91-assets/cart-375.png) | [PNG](91-assets/cart-1280.png) |
| 有商品的結帳 | [PNG](91-assets/checkout-375.png) | [PNG](91-assets/checkout-1280.png) |
| 已付款訂單詳情 | [PNG](91-assets/orders-detail-375.png) | [PNG](91-assets/orders-detail-1280.png) |
| 有訂單的列表 | [PNG](91-assets/orders-list-375.png) | [PNG](91-assets/orders-list-1280.png) |
| 有商品的特價 | [PNG](91-assets/sale-375.png) | [PNG](91-assets/sale-1280.png) |
| 內容（關於） | [PNG](91-assets/content-about-375.png) | [PNG](91-assets/content-about-1280.png) |

主代理已逐張檢視 18 張截圖；這是工程檢查，owner 核可另行記錄。

## Lighthouse 與 #60 比較

[#60 歷史報告](60-redesign.md) 在 preview、Chrome 154.0.8037.92 執行。為控制部署與機器差異，本次另將 #60 原提交 `9006075` 在同一本機、相同工具與 4／32 seed 重新量測五個共同路徑；同樣使用數量 2 的 Luma 購物車。產品與訂單 ID 是隔離資料庫的 ID，頁面資料已核對。

| 頁面 | #60 preview P | #60 同環境重測 P | 本次 P | 本次 A | 本次報告 |
| --- | ---: | ---: | ---: | ---: | --- |
| 首頁 | 99 | 97 | 100 | 100 | [HTML](91-assets/home.report.html) / [JSON](91-assets/home.report.json) |
| 詳情 | 100 | 100 | 100 | 100 | [HTML](91-assets/detail.report.html) / [JSON](91-assets/detail.report.json) |
| 購物車 | 100 | 100 | 100 | 100 | [HTML](91-assets/cart.report.html) / [JSON](91-assets/cart.report.json) |
| 分類 | 100 | 100 | 100 | 100 | [HTML](91-assets/category.report.html) / [JSON](91-assets/category.report.json) |
| 搜尋 | 100 | 100 | 100 | 100 | [HTML](91-assets/search.report.html) / [JSON](91-assets/search.report.json) |
| 結帳（新增） | — | — | 96 | 100 | [HTML](91-assets/checkout.report.html) / [JSON](91-assets/checkout.report.json) |
| 訂單（新增） | — | — | 100 | 100 | [HTML](91-assets/orders.report.html) / [JSON](91-assets/orders.report.json) |
| 特價（新增） | — | — | 100 | 100 | [HTML](91-assets/sale.report.html) / [JSON](91-assets/sale.report.json) |

五個共同路徑的 Performance／Accessibility 相對歷史值與同環境重測均沒有下降；所有八頁皆 ≥90。歷史與同環境舊版的 Accessibility 也皆為 100。這是單次手動量測的結果，不能據此推論所有裝置的載入速度。

[同環境舊版 manifest](91-assets/baseline-60/manifest.json) 包含五份 HTML／JSON 的相對連結、時間、版本與購物車證據；最終網址均為預期路徑，結帳、訂單與購物車都是有資料的畫面，沒有將登入頁或空狀態當成通過。

## 自動化與核可

#89 PR #102：提交 `0e0249d` 的 CI test／e2e 全綠；#90 PR #101：提交 `35b6846` 的 CI test／e2e 全綠。聚焦 E2E 分別 8／8 與 14／14，Web coverage 438／438。#91 整合附件的 CI 結果以本 PR checks 為準。

- [x] 所需頁面 375／1280 截圖與 axe／溢出檢查完成。
- [x] 重跑 Lighthouse、新增三頁並記錄 #60 比較。
- [ ] owner 審閱核可。收到明確核可後才完成 #91、關閉 parent #76。

## 重現此份驗收

[實際執行腳本](91-assets/capture-final.mjs) 原樣保存，SHA-256 與 public manifest 的 `scriptSha256` 完全一致。另保存[中止的前置檢查腳本](91-assets/capture-stopped-preflight.mjs)，雜湊與 stopped-preflight 紀錄一致；它只供追溯，請執行完成版。

使用隔離 worktree `9c0c160`，先執行 `bun install --frozen-lockfile`，再用既有 `bun e2e/harness/serve.ts` 啟動 production harness。等待 localhost:8790 就緒，將 harness 產生的 `.wrangler/e2e/admin-access-jwt` 寫成該 worktree 的 `apps/web/.dev.vars` 中 `ACCESS_DEV_JWT`（僅本次假 E2E token），然後執行 `bun e2e/seed/demo-seed.ts local http://localhost:8790`；確認 4 個分類、32 件上架。這與本次擷取使用相同資料與偽身份，不使用正式店面或 owner 的 cookie。

將 `TASK_REPLAY_WORKTREE` 設為此隔離 worktree 的絕對路徑。腳本會把 Chrome 設定檔放在腳本旁，因此必須先複製到新建的暫存目錄，再執行：

```sh
TASK_REPLAY_ROOT=$(mktemp -d)
cp docs/acceptance/91-assets/capture-final.mjs "$TASK_REPLAY_ROOT/capture-final.mjs"
bun "$TASK_REPLAY_ROOT/capture-final.mjs" "$TASK_REPLAY_WORKTREE" "$TASK_REPLAY_ROOT/reports"
```

執行前以 `lsof -nP -iTCP:19229 -sTCP:LISTEN` 確認選用的 CDP 埠未占用。若已有服務，先選另一個未占用埠，透過 `LH_CDP_PORT` 指定，避免連到既有瀏覽器。兩個原始腳本記錄本機 Google Chrome 標準路徑與本次 Lighthouse 13.5.0 的 npm cache 絕對路徑；換機時需先調整這兩個工具路徑。調整後腳本會自行記錄新的雜湊與版本，產生的是新量測，不覆寫本次原始報告。完成後停掉自己的 harness 並保留完整 reports；不要把 Chrome 設定檔加入 Git。
