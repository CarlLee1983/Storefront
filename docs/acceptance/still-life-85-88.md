# 靜物文案與品牌驗收：#85–#88

日期：2026-10-02。依 owner「#83 已經完成」指示，四個實作代理分別完成 #85、#86、#87、#88，主代理整合並驗收。[文案依據](../copy/83-still-life-review.md)。

## 交付範圍

| 工單 | 主要檔案 | 結果 |
| --- | --- | --- |
| #85 | `apps/web/src/layouts/Layout.astro`、`metadata.ts`、動態頁、`public/brand/` | Still Life 字標、靜物頁籤、description、canonical、OG、Twitter、SL favicon 與後備圖片、完整頁尾與聯絡方式。商品與分類分享圖片及分類無圖片的品牌備援皆已驗證。 |
| #86 | `pages/about.astro`、`faq.astro`、`returns.astro`、`404.astro`、`500.astro`、`components/NotFoundContent.astro` | 核可內容、購物方式與營運資訊；一般、商品及分類 404 共用搜尋與全部商品出口；500 提供顧客可採取的下一步。 |
| #87 | `home/content.ts`、`components/HomeHero.astro`、購物車與結帳頁、`checkout/`、`orders/`、`payments/redirects.ts` | 全部商品連結用語一致、三張輪播 CTA 對應分類、空狀態出口、欄位錯誤與關聯、訂單付款退款顧客文案、圖片替代文字與標點。 |
| #88 | `demo/catalog.json` | 32 件商品說明逐一採用核可段落，接空行、尺寸與材質。與 `fd051ae` 比對確認只有 32 個 `products[].description` 值改變。 |

`README.md` 補充品牌、分享資訊與示範規格說明；既有 E2E 文案斷言同步更新，新增 `e2e/tests/content-pages.spec.ts`。共用商品連結與結帳商品欄已提供名稱，因此其中的重複封面設為裝飾語意；購物車獨立封面保留無障礙名稱。未排除任何 axe 規則。

後續審查補正：頁尾分類連結使用目前有上架商品的分類名稱與代稱，空分類不顯示。首頁三張主視覺只有在對應示範分類有上架商品時保留核可的分類 CTA；否則顯示「全部商品」並連到 `/products`，避免空店或自訂分類店面出現失效分類連結。以空店面、自訂分類及單一示範分類的 E2E 情境覆蓋此行為。
補正後 `bun run typecheck`、聚焦 E2E 20 tests、完整 E2E 83 tests 與 `git diff --check` 均通過。

結帳僅在 App 回傳 `invalid_input` 時於伺服器重用既有 `checkoutInput` 驗證，保留欄位路徑並映射固定顧客訊息；`apps/app/package.json` 新增私有 workspace 的 `orders-input` 子路徑。RPC 回傳結構、付款與訂單狀態邏輯維持既有契約。沒有新依賴或 migration；管理後台繼續使用原有狀態文案。

## 檢查結果

為避開同一工作區另一項後台工作的測試伺服器，驗收使用獨立來源副本與測試埠 18790／18791，偵錯埠 19330／19331。來源比對確認 App、Web、Gateway、E2E 測試與 seed、品牌資產、catalog、套件檔及 lockfile 與工作區相同；只有副本的 harness 埠不同。未複製環境憑證；測試身分由既有 harness 產生。

| 檢查 | 結果 |
| --- | --- |
| `bun run typecheck` | 四個 workspace 通過，0 errors；Web 0 warnings，1 個既有 hint。 |
| `bun run test:coverage` | 1,054 tests 通過，三個 workspace 的 statements／branches／functions／lines 均超過 80% 門檻。 |
| `bun test ./seed`（於 `e2e`） | 13 tests 通過。 |
| `bun run e2e` | 完整 82 tests 通過，0 failed、0 skipped；包含真實本機 webhook、付款導回與出貨主流程。 |
| 內容頁與錯誤頁 | 375／1280px 檢查通過；共用外殼另測 320／768／1280px，無水平溢出，axe 零違規。 |
| 獨立審查 | 初次 finding 已修正或完成範圍判定；最後的測試差異及結帳封面修正獨立審查均為 clean。 |
| `git diff --check` | 通過。 |

| Workspace | Tests | Statements | Branches | Functions | Lines |
| --- | ---: | ---: | ---: | ---: | ---: |
| App | 535 | 96.71% | 92.26% | 94.00% | 97.10% |
| Gateway | 81 | 97.09% | 91.47% | 94.11% | 96.91% |
| Web | 438 | 87.63% | 89.64% | 89.80% | 87.62% |

覆蓋率通過後，只有 Astro 顯示語意與 E2E 斷言再修正；受覆蓋率衡量的 TypeScript 邏輯未變更，沿用通過結果，重跑完整型別與瀏覽器檢查。

## 本機重新植入與截圖

使用既有 `e2e/seed/demo-seed.ts` CLI 與後台表單，在隔離 harness 的本機 D1／R2 完成以下順序：

1. 以 `fd051ae:demo/catalog.json` 植入四個分類、32 件商品，瀏覽全部詳情頁確認舊說明並記錄商品編號。
2. 將 fixture catalog 換成目前版本，執行 `bun .wrangler/acceptance-85-88/fixture/e2e/seed/demo-seed.ts local http://localhost:18790`。
3. CLI 更新 32 件既有商品，新增商品 0 件、追加圖片 0 張。[更新紀錄](still-life-85-88/seed-update.log)。
4. 逐一瀏覽 32 件商品，確認 HTTP 200、編號不變、說明全文與 `textContent`／`innerText` 一致、段落空行及尺寸材質分行正確。另確認售價、庫存與精選值與原清單一致，32 件全數上架，沒有重複商品。
5. 截圖並人工檢查 Luma 弧形單椅在手機與桌機的段落、規格換行及頁尾，兩個尺寸均無水平溢出。

- [375px 手機截圖](still-life-85-88/product-375.png)
- [1280px 桌機截圖](still-life-85-88/product-1280.png)

驗收 harness 已停止。本次未寫入 preview 或 production，未提交、推送或部署。

## 範圍與恢復方式

文案稿明示四個分類 blurb 的替換另待核可，因此保留既有分類資料與 seed 的分類略過規則。無效的列表網址參數沿用既有正規化契約；App 回傳 `invalid_input` 時仍使用核可的錯誤訊息及恢復連結。#89–#91 的視覺工作與同時進行的後台改版不屬於本次交付。

尺寸與材質是示範展示資料，尚非實體商品量測；網站維持「示範網站，不實際出貨」聲明。前台程式與品牌資產可依本次差異回復；已植入的商品說明若要恢復，先還原 catalog，再於取得授權的目標重跑既有 seed。沒有資料表或支付狀態遷移。
