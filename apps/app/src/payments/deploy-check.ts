/** 部署前檢查用（`scripts/check-auth-deploy.ts`），不被 Worker 引用。 */
import type { DeployEnv } from "../auth/deploy-check";

/** App 需要的 secret（閘道 API 金鑰）；`GATEWAY_BASE_URL` 是 wrangler.jsonc 的純文字 var。 */
export const APP_PAYMENT_SECRET_NAMES = ["GATEWAY_API_KEY"] as const;
/** Web 需要的 secret（驗 webhook 簽章用），必須與閘道的 `GATEWAY_WEBHOOK_SECRET` 相同。 */
export const WEB_PAYMENT_SECRET_NAMES = ["GATEWAY_WEBHOOK_SECRET"] as const;

const PLACEHOLDER = "REPLACE_WITH_";

/**
 * 回傳部署後會讓付款不可用的問題。secret 的值是 write-only，只能檢查名稱是否存在；
 * `GATEWAY_BASE_URL` 是純文字 var，未填或仍是佔位值時 App 會把它當設定錯誤、付款 RPC 一律 fail closed。
 */
export function checkPaymentDeploy(input: {
  deployEnv: DeployEnv;
  gatewayBaseUrl: string | undefined;
  appSecretNames: readonly string[];
  webSecretNames: readonly string[];
}): string[] {
  const problems: string[] = [];
  const url = input.gatewayBaseUrl;
  if (!url || url.includes(PLACEHOLDER) || !URL.canParse(url)) {
    problems.push(`apps/app/wrangler.jsonc 的 env.${input.deployEnv}.vars.GATEWAY_BASE_URL 尚未填入閘道的網址`);
  }
  for (const name of APP_PAYMENT_SECRET_NAMES) {
    if (!input.appSecretNames.includes(name)) problems.push(`App 缺少 ${name}`);
  }
  for (const name of WEB_PAYMENT_SECRET_NAMES) {
    if (!input.webSecretNames.includes(name)) problems.push(`Web 缺少 ${name}`);
  }
  return problems;
}
