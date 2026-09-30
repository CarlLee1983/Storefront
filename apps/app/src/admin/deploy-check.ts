/** 部署前檢查用（`scripts/check-auth-deploy.ts`），不被 Worker 引用。 */
import type { DeployEnv } from "../auth/deploy-check";

/** 內嵌 JWKS 只給本機開發與測試（見 `access.ts`）；preview / production 不得定義。 */
const JWKS_NAME = "ACCESS_JWKS_JSON";

/**
 * 回傳部署後會讓管理後台驗簽信任本機金鑰的問題：
 * - `ACCESS_TEAM_DOMAIN` 是 `.invalid` 保留網域（`local.invalid` 會讓 App 採用內嵌 JWKS）；
 * - `ACCESS_JWKS_JSON` 出現在該環境的 vars 或 secret 名稱。
 * 只看得到 wrangler.jsonc 的 vars 與 `wrangler secret list` 的名稱；在 dashboard 另設的純文字 var 看不到，
 * 那種情形由 `access.ts` 的執行期檢查（真實網域搭配內嵌 JWKS 視為設定錯誤）擋住。
 */
export function checkAccessDeploy(input: {
  deployEnv: DeployEnv;
  teamDomain: string | undefined;
  appVarNames: readonly string[];
  secretNames: readonly string[];
}): string[] {
  const problems: string[] = [];
  const domain = (input.teamDomain ?? "").toLowerCase().replace(/\.$/, "");
  if (domain.endsWith(".invalid")) {
    problems.push(`apps/app/wrangler.jsonc 的 env.${input.deployEnv}.vars.ACCESS_TEAM_DOMAIN 是 .invalid 保留網域（本機專用）`);
  }
  if (input.appVarNames.includes(JWKS_NAME) || input.secretNames.includes(JWKS_NAME)) {
    problems.push(`${input.deployEnv} 不得定義 ${JWKS_NAME}（內嵌 JWKS 只給本機）`);
  }
  return problems;
}
