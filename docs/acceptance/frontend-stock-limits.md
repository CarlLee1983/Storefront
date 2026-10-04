# 前台可售數量限制驗收

日期：2026-10-04。依[已確認方案](../plans/frontend-stock-limits-design.md)實作。本機驗證完成，未部署 preview 或 production。

## 修正內容

- 商品頁、所有商品卡快速加入、購物車與結帳共用可售數量判斷，依變體計算；超量加入整次拒絕，不截短數量或更新原筆價格。
- 新增公開、每次最多 20 個變體的 `getAvailability` / `/api/availability`，沿用既有可售數量算式。回應不快取、不含管理庫存明細；下架／停賣／不存在與售完、查詢失敗分開處理。
- 庫存下降時保留購物車原數量、顯示可購買數量並阻擋結帳。結帳可直接減量／移除，保留收件欄位並重算運費及總額。
- 操作、頁面進入及快取頁恢復時更新，忽略過期回應。數量寫入在支援 Web Locks 的瀏覽器共用跨分頁鎖，鎖內重讀購物車；不支援時仍在同步區段檢查／寫入。最終下單仍使用既有原子庫存條件。
- 查詢失敗顯示持續提示與重試；不能增加或結帳，仍能減量與移除。超過 20 種變體的舊購物車分批讀取並明確提示訂單限制。
- 沒有新依賴、遷移或購物車格式變更。App 須先部署、再部署 Web；回復順序 Web → App。

## 回歸證據

先執行 `bun run --filter @storefront/web test src/cart/cart.test.ts`，確認舊程式在可售 4 件卻加入 5 件、以及超過 99 件時部分加入的案例失敗，再修正原購物車判斷。

新增與調整的測試：

- App `availability.test.ts`：保留與不可售數量扣除、公開欄位、售完／下架／停賣、輸入與批次上限。
- Web `cart.test.ts`、`availability.test.ts`、`purchase.test.ts`：整次拒絕、價格不變、99 件上限、分批查詢、過期回應、查詢／儲存失敗、跨分頁鎖與競爭加入、離線減量及移除。
- E2E `stock-limits.spec.ts`：實際可售 4 件、商品頁和快速加入、庫存下降保留數量、持續錯誤提示與重試、結帳內修正、快取頁恢復，以及查詢中跨分頁更新的畫面同步。
- 更新 `detail-cart-redesign.spec.ts` 的舊 99 件上限斷言，以及 `variants.spec.ts` 的停賣商品提前阻擋斷言，保留桌機／手機無障礙及鍵盤焦點驗證。
- 運費、履約、售後等既有 E2E 的加入流程改為每次點擊後等待確切購物車件數，再導航；保留所有原有金額與數量斷言，避免查詢未完成就換頁。
- 原有 `product-detail.spec.ts` 驗證加入後仍保留按鈕焦點；新增 toast 計時器回歸，確認新請求開始時取消上一筆尚未播出的結果。

聚焦 E2E：`cd e2e && bun run e2e tests/stock-limits.spec.ts tests/detail-cart-redesign.spec.ts tests/cart-checkout-redesign.spec.ts --project=chromium --no-deps`，11 項通過。

## 完整檢查

- 型別：工作區 `bun run typecheck`，後續異動另跑 Web typecheck 與 E2E typecheck，均通過。Astro 保留原有 4 個 hints，0 errors／0 warnings。
- Coverage：工作區執行後，修正 RPC 白名單與測試 fixture，再重跑受影響的 App／Web 完整 coverage；三個模組全部通過 80% 門檻，共 1,892 項測試。

| 模組 | 測試數 | Statements | Branches | Functions | Lines |
| --- | ---: | ---: | ---: | ---: | ---: |
| App | 1,088 | 94.20% | 90.19% | 88.45% | 94.44% |
| Web | 701 | 88.01% | 90.72% | 86.79% | 87.38% |
| Gateway | 103 | 95.51% | 91.66% | 88.54% | 95.38% |

E2E 共 167 項全部通過，沿用相同產品程式的既有通過結果並補跑受影響／先前未執行的 project：

- `bun run e2e -- --max-failures=0`：158 項通過；運費測試的最後一次加入少了非同步完成等待，造成 2 項失敗、依賴它的 7 項未執行。
- 補齊等待後，`bun run e2e -- tests/shipping-rates.spec.ts --project=shipping-rates --no-deps`：2 項通過。
- `bun run e2e -- tests/contact-mailbox.spec.ts --project=contact-mailbox --no-deps`：7 項通過。

後兩次只修改測試中的完成等待，產品程式保持一致；合計驗證全部 167 項。測試使用本機隔離的 E2E 狀態，各次 harness 會重建該狀態，不影響 preview 或日常開發資料。最後的 tracked diff 與新增檔案 whitespace 檢查通過。

## 審查與限制

Architect 確認查詢邊界與既有訂單原子防線。Independent reviewer 指出的查詢失敗仍顯示舊庫存，以及跨分頁更新後修改已移除的輸入框，均已修正並有 E2E 回歸；後續按鈕焦點、提示計時器與測試完成等待的差異也經複查，無剩餘實質發現。

前台可售數量是讀取時快照，沒有替購物車保留商品；其他顧客仍可能在送出訂單前買走，後端會再次檢查並拒絕不足數量。未在遠端建立測試訂單或更動庫存。
