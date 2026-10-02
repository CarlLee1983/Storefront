# 結帳與訂單格線版面（#89）

狀態：本機實作與焦點驗證完成；整合 CI 與正式視覺審閱待完成。規格：#76、#89；本機起點 `100bce7`，#84 已通過 CI 並合併。

結帳、訂單列表／明細、付款提示與 toast 改成格線／分隔線／留白。結帳大標沿用購物車的展示字級，訂單詳情將進度、收件資訊、品項與付款資訊分區。顧客訂單標籤統一為方形中性外框；後台標籤預設及支付流程保留。

`bun install --frozen-lockfile`、`bun run typecheck`（Web 0 errors）、`bun run --filter @storefront/web build` 及 `git diff --check` 通過。`bun run --filter @storefront/web test:coverage` 通過：34 個檔案、438 個測試，Statements 87.63%、Branches 89.64%、Functions 89.8%、Lines 87.62%。

既有 production-build Playwright harness 執行 `bunx playwright test tests/cart-checkout-redesign.spec.ts tests/orders-redesign.spec.ts tests/sale.spec.ts tests/main-flow.spec.ts --no-deps --workers=1`，8／8 通過（44.4 秒）。測試在 375／1280 驗證結帳、訂單詳情與列表、已建立及付款失敗／已取消／已出貨狀態、實際有商品的特價頁，斷言無頁面水平溢出與 axe 零違規；亦確認收件資訊與付款紀錄可見，結帳與購物車大標同層級。各流程透過 `testInfo.attach` 產生頁面截圖；正式視覺審閱由 #91 整合驗收進行。

沒有新增 API、資料遷移或依賴。獨立 Standards／Spec 審查與完整 CI 由整合分支執行；本工作樹沒有重跑完整 E2E。
