# 詳情頁圖庫與全站排印（#90）

規格：#76、#90；起點 `100bce7`（#84 的 token 與 #85–#88 的顧客文案）。

商品詳情圖庫使用正方形的圖片框、淺灰底與 `cover` 裁切，使非正方形商品圖片填滿畫面。圖庫的滑動、方向鍵、縮小圖與焦點程式碼沒有改動。前台一般頁面的 h1 使用 #84 的頁面展示字級 token；商品詳情標題保留較小的商品展示層級。首頁各區段及商品相關區段已使用 #84 的區段間距 token。

檢視三張首頁圖片後，各張分別設定焦點位置：客廳保留右側單椅與地面，餐廳保留桌椅與吊燈，工作區保留桌面與檯燈。圖片仍使用既有素材與文案，依構圖在裁切時保留主體。

## 驗證

- `bun run --filter @storefront/web typecheck`：通過，0 errors、0 warnings（1 個既有 hint）。
- `bun run --filter @storefront/e2e typecheck`：通過。
- `bun run --filter @storefront/web build`：通過。
- `bun run --filter @storefront/web test:coverage`：34 files、438 tests 通過；statements 87.63%、branches 89.64%。
- `bun run --filter @storefront/e2e e2e tests/product-detail.spec.ts --project=chromium --no-deps`：2 passed，包含既有鍵盤／觸控圖庫流程與新增的 375／1280 圖庫方形幾何、水平溢出、axe 零違規檢查。
- `bun run --filter @storefront/e2e e2e tests/homepage.spec.ts --project=home --no-deps`：12 passed，包含 375／1280 首頁水平溢出與 axe 零違規檢查。
- 兩支 E2E spec 執行時擷取了頁面截圖附件；list reporter 未保留獨立圖片檔，owner 視覺審閱仍待整合。測試不斷言 CSS 色值。

既有圖庫觸控捲動後的對齊斷言在本分支前已有不穩定記錄；本次聚焦執行通過。完整整合 CI 由主分支執行。
