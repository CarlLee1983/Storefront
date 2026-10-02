# 前台設計 token 與視覺語言（#84）

基準：`45d6351`；規格：#76、#84。

`Layout` 載入 `storefront.css` 並在 body 加上 `storefront-shell`。展示字級、區段間距、主要 CTA 最小高度、商品小圖尺寸與錯誤色只在前台定義。前台沿用 40、56.25、64rem 三個版面斷點；後台的 48rem 斷點獨立保留。共用的 `global.css` 和 `AdminLayout` 未改動，訂單狀態元件只在前台 scope 內覆寫強調色。

次要控制項使用中性外框：登出、商品圖庫箭頭、購物車與結帳的移除，以及取消訂單。內文連結和導覽狀態改中性色；朱紅保留在主要 CTA、特價售價、折扣標籤及編輯式橫幅。錯誤色是紫色系 `#672579`，在白底上對比度約 9.9:1。中文標題字重 700、無負字距；價格使用等寬數字。

## 驗證

- `bun run --filter @storefront/web typecheck`：通過，0 errors、0 warnings（1 個既有 hint）。
- `bun run --filter @storefront/web test:coverage`：34 files、434 tests 通過；statements 88.07%、branches 91.92%。
- `bun run --filter @storefront/web build`：通過。
- `bun run e2e`：52 passed、1 failed、24 did not run（1.6m）。唯一失敗為既有 `product-detail.spec.ts` 圖庫滑動後對齊斷言：要求 <2px，實測 17px；同一斷言在基準工作樹亦失敗。其餘已執行的前台與後台測試通過，包含 axe 與水平溢出檢查。
- 375／1280 截圖：待整合階段擷取並交 owner 審閱；視覺色彩和字體不以 CSS 值斷言。

圖庫對齊失敗阻擋完整 E2E，後續依賴專案的 24 個測試未執行。Lighthouse 人工量測、獨立審查及 CI 仍由整合階段完成。
