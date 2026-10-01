---
status: accepted
---

# 商品圖片在上傳時預先縮放存進 R2，Web 直接唯讀送圖

前台以手機優先，列表不能載原圖。我們在後台上傳時由瀏覽器先縮成固定幾種尺寸並轉成 WebP，存進 R2，前台以 `srcset` 挑尺寸；不採用 Cloudflare 的讀取時圖片轉換服務，因為它另外計費，而這裡只需要固定的幾種尺寸。

R2 bucket 同時綁在兩個 Worker 上：App 負責寫入與刪除（經管理員驗證），Web 只讀，以內容雜湊為 key 直接送圖並設 `immutable` 長效快取。這偏離了 Holdfast [ADR 0005](https://github.com/CarlLee1983/Holdfast/blob/main/docs/adr/0005-web-app-split-via-rpc.md)「Web 只透過 App 取得資料」的原則；讀圖不含業務邏輯，繞經 App 只多一跳。

## Consequences

- 尺寸在上傳當下就固定了，日後要改尺寸只能重新上傳，無法從原圖重算（不保存原圖）。
- 知道網址就讀得到已下架商品的圖片，對商品照片可以接受。
- Web 的「唯讀」只靠程式慣例維持，wrangler 的 R2 binding 本身不區分讀寫。

**Falsified if:** `apps/web/wrangler.jsonc` 不再綁定商品圖片 bucket（改由 App 經 RPC 送圖）、Web 的程式對該 bucket 呼叫 `put` 或 `delete`，或 `apps/web/wrangler.jsonc`、`apps/app/wrangler.jsonc` 啟用讀取時的圖片轉換（Images binding）。
