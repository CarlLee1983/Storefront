# 訂單管理列表與訂單明細（#82）

狀態：本機實作與焦點驗收完成；完整驗證仍受下述既有圖庫失敗與覆蓋率逾時限制。基準：`45d6351`；規格：#75、#82。驗證日期：2026-10-02。

## 變更

- 訂單列表改用依內容配置欄寬的後台表格；商品封面在後台縮為 44px，與品名並排。Email 優先在 `@` 與 `.` 前斷行；單一片段超過可用寬度時才允許字中換行，避免有效的 64 字元 local-part 撐破表格。
- 小於 48rem 時，訂單列表、明細與付款紀錄以卡片呈現；數量、小計與需要處理標示保留在視窗內。
- 僅修改後台訂單頁與 `.admin-shell` 樣式，沒有新增依賴、資料遷移或 API 變更。

範圍限定後台頁面與後台 CSS；App RPC、資料庫、授權、出貨規則及前台訂單封面沒有變更。獨立 Standards／Spec 審查與 CI 由整合分支處理。

## 驗證

`admin-orders.spec.ts` 沿用既有正式建置 E2E harness：經後台建立四件有封面的商品，以獨立顧客 session 與 64 字元、無標點的 email local-part 結帳；透過模擬閘道建立失敗與成功兩次付款，再在 E2E 專用 D1 加入退款失敗紀錄，使正式 App 查詢回傳「需要處理」。在 1280 與 375px 驗證列表與明細：email 全文、四品項、44px 封面與品名並排、手機卡片、數量與小計、三筆付款、同列篩選、頁面與各表格容器沒有水平溢出、可見控制項至少 44 × 44px，且 axe 零違規。新增案例在原 CSS 下於 1280px 測得表格寬 1312px、容器寬 1216px，修正後焦點 E2E 4/4 通過。

`bun install --frozen-lockfile`、`bun run typecheck`、`bun run --filter @storefront/web test:coverage` 均通過；Web 共 434 個測試。

`bunx playwright test tests/admin-orders.spec.ts --project=chromium` 通過，包含相依空店面測試共 4 個。

修正 64 字元 email 前執行的完整 `bun run e2e`：53 個通過，`product-detail.spec.ts:88` 前台圖庫手機滑動後的對齊斷言失敗（偏移 10px，預期小於 2px），24 個相依測試未執行。#82 測試在當次完整執行中通過；後續 email 修正另以焦點 E2E 驗證。此同一斷言已記錄於 [#77 驗收紀錄](77-admin-shell.md) 的未修改起點，因此完整 E2E 不能視為全部通過。

完整 `bun run test:coverage` 在 App 的多個既有測試逾時後中止（exit 130）：`admin-orders.test.ts` 的最新 200 筆測試、`cancel.test.ts` 的並行測試，以及 `checkout.test.ts` 的輸入驗證。Gateway 在中止前通過 81 個測試；Web 的覆蓋率另行獨立執行並通過。此測試結果不能視為完整覆蓋率通過。
