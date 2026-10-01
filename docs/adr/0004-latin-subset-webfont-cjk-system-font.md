---
status: accepted
---

# 只載入子集化的拉丁網頁字型，中文沿用系統字體

前台改版以瑞士極簡風格為目標，視覺張力來自粗而緊的無襯線字體。#29 原本決定不載入任何網頁字型；這次推翻該決定，但只載入一套子集化的拉丁網頁字型，用於品牌名、價格、數字與英文小標，中文仍用系統字體，靠字級與字距補足標題力道。中文網頁字型即使子集化也動輒數百 KB 到數 MB，會拖垮首屏，也守不住手機版 Lighthouse Performance ≥ 90（#37）；純系統字體則讓價格與數字缺乏辨識度。

## Considered Options

- 全部用系統字體：零成本，但 PingFang TC 最粗只到 Semibold，大標題做不出參考稿的力道。
- 子集化的中文網頁字型（例如 Noto Sans TC Black）：中文標題最接近參考稿，但字集會隨商品名稱與文案變動，子集要跟著重做，檔案大小也難以控制。

**Falsified if:** `apps/web/src/styles/global.css` 的 `@font-face` 載入了涵蓋 CJK 的字型，或首頁、商品詳情頁、購物車的手機版 Lighthouse Performance 因字型載入跌破 90。
