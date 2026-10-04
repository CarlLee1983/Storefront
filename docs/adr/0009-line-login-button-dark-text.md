---
status: accepted
---

# LINE 登入按鈕保留品牌綠底、改用深色字

LINE 官方按鈕規範是綠底白字，但白字在 `#06c755` 上對比只有 2.25:1，低於 WCAG AA 的 4.5:1，前台無障礙測試因此失敗。我們保留 LINE 品牌綠底、文字改為深色（實測 7.78:1，hover 6.12:1），讓顧客仍一眼認出 LINE，同時達到 AA。

這放棄了與 LINE 官方規範完全一致。考慮過的替代方案：加深底色到約 `#058a3c` 保留白字（對比約 4.6:1，但不再是品牌綠），或白底綠框深字（偏離品牌識別最多）。日後若要「修回」白字，必須同時換掉底色，否則無障礙測試會再次失敗。

**Falsified if:** `apps/web/src/pages/login.astro` 的 `.social-button.line` 改回白字且底色仍為 `#06c755`，或 `e2e/tests/accessibility.spec.ts` 不再掃描登入頁的對比。
