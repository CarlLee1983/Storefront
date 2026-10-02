# 商品管理與新增流程 DAG（#78–#81）

驗證日期：2026-10-02。起點為 `fd051ae`（#77 後台外殼）。依序派發實作代理完成 #78 → #79 → #80 → #81；主代理負責路由、授權邊界、整合與驗收，另由 architect 分析新增路由及 reviewer 獨立檢查實作與修正差異。#82 直接依賴 #77，不在本條路徑內。

## 交付與證據

| Issue | 最終行為 | 驗收證據 |
| --- | --- | --- |
| #78 | 商品表格有封面、名稱、分類、售價、原價、在庫數、保留數、可售數量、狀態、精選、操作；移除說明欄。數字靠右、等寬數字，只有名稱可換行；操作有間距，庫存提示完整，錯誤與輸入框關聯並顯示在列表上方。 | `admin-products.spec.ts` 驗證 32 件示範商品及長名稱、精選、尚未上架商品共存；1280px 不溢出、控制項至少 44px、不重疊、錯誤前後欄位尺寸與水平位置相同。 |
| #79 | 小於 48rem 使用商品卡片，桌機使用表格；共用同一份 DOM、資料與表單。 | 375px 頁面及列表不溢出、axe 零違規，UI 完成庫存調整、上下架與精選切換；767／768px 驗證版面切換。 |
| #80 | 商品管理頂端進入 `/admin/products/new`，建立後 303 到 `/admin/products/:id?saved=created`；編輯頁可接續分類與圖片操作。清單移除新增表單及舊新增 POST。 | `admin-product-create.spec.ts` 驗證 375／1280px、axe、轉址、輸入保留、403、未知操作與舊 POST 拒絕且不新增商品。分類管理流程及真實 seed 驗證新頁建立後上傳圖片、設定分類與上架。主流程呼叫端已更新；其完整通過限制見下節。 |
| #81 | 新增分類移到 `/admin/categories`；商品頁移除分類摘要、表單與建立分支。分類表依內容配置欄寬，手機單欄，修改與刪除分欄並有區隔。 | `admin-categories.spec.ts` 驗證 375／1280px 無溢出、44px 控制項、操作間距、axe、重複與非法代稱、輸入保留、403、未知操作及舊商品頁 POST 拒絕。空店面可使用分類新增表單；既有分類管理流程通過。 |

所有路由沿用 App 的 JWT 驗證，Web 只轉交 JWT。新增頁 GET 也經 App 授權讀取。沒有新增依賴、App API、資料庫 schema 或領域規則變更；前台全域表單與表格樣式沒有修改。

桌機整合曾發現 11px 溢出。縮小案例加入尚無圖片、未分類、未上架商品後，穩定重現 1251px 內容超過 1216px 容器；較長的「重新上架」控制項增加操作欄寬。僅將桌機商品表格的欄位水平 padding 從每側 8px 改為 6px，控制項及其間距保留。回歸案例先失敗、修正後通過，兩個商品測試也在完整 E2E 中通過。獨立 reviewer 對初版與此修正差異均無實質發現。

## 共用工作樹驗收檢查

- `bun run typecheck` 通過，Astro 只有既有 `HomeHero.astro` hint。
- `bun run test:coverage` 通過：App 535、Web 438、Gateway 81，共 1,054 個測試，三個套件覆蓋率門檻均通過。Web 數量包含同步的前台測試變更。
- `bun run --filter @storefront/e2e test`：13 個 seed 清單及目標環境單元測試通過。
- `git diff --check` 通過。
- 最後獨立執行空店面、四個新增後台 spec、後台外殼、分類管理及主流程：19 個後台／空店面測試通過；主流程在前台商品列表 axe 失敗。命令如下，沒有修改永久 Playwright 設定或放寬斷言：

```sh
cd e2e
bunx playwright test tests/empty-store.spec.ts tests/admin-products.spec.ts \
  tests/admin-product-create.spec.ts tests/admin-categories.spec.ts \
  tests/admin-seed-guard.spec.ts tests/admin-shell.spec.ts \
  tests/category-management.spec.ts tests/main-flow.spec.ts \
  --project=empty-store --project=chromium --project=main-flow \
  --no-deps --workers=1
```

## 示範資料 CLI

以拋棄式工作目錄複製當前 seed 原始碼，使用 E2E harness 新產生的測試 JWT，執行兩次 `bun run seed local http://localhost:8790`。未複製環境憑證，也未改寫開發中的 `.dev.vars`、`.wrangler/state` 或遠端環境。

- 起始隔離資料庫：0 個分類、0 件商品。
- 第一次退出碼 0：4 個分類、32 件商品全部上架、47 張商品圖片。
- 第二次退出碼 0：仍為 4 個分類、32 件商品全部上架；`products`、`categories`、`product_images` 的完整資料列逐一比對與第一次相同，沒有重複、額外圖片或庫存變動。
- seed 的寫入前確認要求正確 origin、`/admin` 路徑、成功 HTTP 回應、商品管理標題、目前導覽與新增商品連結；E2E 拒絕其他應用頁面及同源錯誤轉址。
- 實際 seed 圖片與商品資料量測：1280px 列表 `clientWidth = scrollWidth = 1216`；375px 列表 `clientWidth = scrollWidth = 343`；兩者頁面寬均等於 viewport。

## 共用工作樹前台限制與 owner 決定

完整 `bun run e2e` 在商品表格修正後：42 通過、9 失敗、31 未執行；兩個商品驗收測試通過。失敗包括前台圖片 `image-redundant-alt`／`duplicate-img-label` axe 規則、商品詳情文案、圖片失效提示與搜尋連結文字；後續重新執行的 setup 也遇到重複分類代稱。

另以 `--no-deps --workers=1` 執行主流程，新後台建立、分類、圖片、庫存、上架與精選步驟均已走完，之後在 `main-flow.spec.ts` 的 `populated-products-mobile` 前台商品列表 axe 檢查失敗。因此不能宣稱當前完整主流程或完整前台 E2E 通過。

Owner 明確選擇：「維持後台範圍，記錄前台失敗並以後台驗收完成」。同步的前台原始碼與斷言保持其工作樹狀態，由前台工作處理。未以修改前台、排除永久設定或放寬無障礙規則來取得通過。

## PR 隔離分支驗證

Owner 要求發 PR 後，以已合併 #77 的 `origin/main`（`a0d4c4f`）建立 `feat/78-admin-products-dag` 隔離 worktree，只抽出後台原始碼、新路由、seed、必要 E2E 呼叫端及文件。共用工作樹的前台品牌、文案、圖片 alt、metadata 及其斷言未帶入。原 reviewer 對抽取差異檢查無實質發現。

- `bun install --frozen-lockfile` 與 `bun run typecheck` 通過；只有既有 Astro hint。
- `bun run test:coverage` 通過：App 535、Web 434、Gateway 81，共 1,050 個測試，全部覆蓋率門檻通過。此數量不包含同步前台新增的測試。
- seed 單元測試 13 項通過；`git diff --check` 通過。
- 隔離分支完整 `bun run e2e`：52 通過、1 失敗、24 未執行。後台驗收測試均通過。唯一失敗為 `product-detail.spec.ts:88` 手機圖庫滑動後偏移 48px，要求小於 2px；[#77 驗收紀錄](77-admin-shell.md) 已在未修改基準重現同一失敗。
- 單獨執行因此未執行的下游 project，24 項全部通過，包含完整購買、付款、webhook 與出貨主流程：

```sh
cd e2e
bunx playwright test --project=listing --project=home --project=sale \
  --project=main-flow --no-deps --workers=1
```

上述下游結果不將圖庫失敗算成通過，沒有修改永久 Playwright 設定或前台原始碼。

## 操作與回滾

README 已更新新路由及列表行為。回滾時應一併回滾後台路由、樣式、seed 與 E2E 呼叫端；沒有資料遷移。實作驗收階段沒有 commit、push、部署或 GitHub issue 寫入；owner 後續要求「發 pr」，因此在獨立 worktree 建立提交並發出 PR。既有共用分支、未提交變更與同步前台工作均保留。
