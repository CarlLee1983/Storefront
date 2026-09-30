---
status: accepted
---

# 管理員的本機驗簽模式由部署前檢查守住

後台由 Cloudflare Access 保護，App Worker 驗證 Access JWT（沿用 Holdfast [ADR 0007](https://github.com/CarlLee1983/Holdfast/blob/main/docs/adr/0007-admin-behind-cloudflare-access.md)）。本機開發與 E2E 沒有 Access 可用，所以 `access.ts` 另有一個模式：`ACCESS_TEAM_DOMAIN` 設成 `.invalid` 網域、`ACCESS_JWKS_JSON` 放一把內嵌公鑰時，就用這把公鑰驗簽，E2E harness 再用對應的私鑰簽出管理員 JWT。

這個模式開啟與否取決於設定值，不取決於程式碼路徑。這正是 Holdfast [ADR 0013](https://github.com/CarlLee1983/Holdfast/blob/main/docs/adr/0013-e2e-login-by-writing-session.md) 對會員登入拒絕的做法：「只靠執行期設定守住」。我們仍然保留它，原因有兩個：

- 管理員的身分來自外部的 Access，本站沒有自己的 session 表可以直接寫入；
- 若改成在 production 程式碼裡加測試分支，那才是真正的後門。

為了讓這個模式無法被悄悄帶進 preview 或 production，部署前的檢查（`checkAccessDeploy`）會擋下以下三種情況，並在套用 migration 之前讓部署失敗：

- `ACCESS_TEAM_DOMAIN` 以 `.invalid` 結尾；
- 該環境的 wrangler vars 定義了 `ACCESS_JWKS_JSON`；
- 該環境設了名為 `ACCESS_JWKS_JSON` 的 secret。

`access.ts` 本身也把「真實網域搭配內嵌 JWKS」視為設定錯誤而拒絕，所以只在 Cloudflare dashboard 手動加的純文字 var 雖然檢查不到，也無法單獨讓這個模式生效。

## Consequences

- 部署前檢查成了安全邊界。檢查被繞過（例如手動 `wrangler deploy`）時，保護只剩 `access.ts` 的「真實網域不接受內嵌 JWKS」這一層。
- E2E 跑的是 production 建置，但用 harness 產生的 `.dev.vars` 啟用本機驗簽模式，不需要修改任何 production 程式碼。

**Falsified if:** `apps/app/src/admin/access.ts` 在非 `.invalid` 網域下也會接受內嵌 JWKS，或 `apps/app/src/admin/deploy-check.ts` 不再擋下 `.invalid` 網域與 `ACCESS_JWKS_JSON`，或 `.github/workflows/deploy.yml` 不再於 migration 前執行 `apps/app/scripts/check-auth-deploy.ts`。
