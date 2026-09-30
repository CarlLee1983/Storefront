// 部署前檢查：顧客登入與付款的設定不全時，部署出去的登入或付款是壞的，所以在 migration 之前先擋下。
//   - BETTER_AUTH_URL 讀 apps/app/wrangler.jsonc 該環境的 vars，並確認等於 apps/web/wrangler.jsonc 該環境 routes 的自訂網域
//   - secrets 讀 `wrangler secret list --env <env>`（值是 write-only，只能檢查名稱存在；需要 CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID）
//   - 付款：GATEWAY_BASE_URL 讀 apps/app/wrangler.jsonc 該環境的 vars（不能是佔位值）；App 的 GATEWAY_API_KEY 與 Web 的 GATEWAY_WEBHOOK_SECRET 兩個 secret 名稱要存在
//   - 管理後台：ACCESS_TEAM_DOMAIN 不得是 `.invalid`（本機專用），ACCESS_JWKS_JSON 不得出現在該環境的 vars 或 secret 名稱
// 用法：bun scripts/check-auth-deploy.ts <preview|production>
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { checkAccessDeploy } from "../src/admin/deploy-check";
import { checkAuthDeploy, parseSecretList, webOriginFromRoutes, type DeployEnv } from "../src/auth/deploy-check";
import { checkPaymentDeploy } from "../src/payments/deploy-check";

const arg = process.argv[2];
if (arg !== "preview" && arg !== "production") {
  console.error("用法：bun scripts/check-auth-deploy.ts <preview|production>");
  process.exit(2);
}
const deployEnv: DeployEnv = arg;

const appDir = path.resolve(import.meta.dirname, "..");

function readWranglerConfig(file: string) {
  const parsed = ts.parseConfigFileTextToJson(file, readFileSync(file, "utf8"));
  if (parsed.error) throw new Error(`無法解析 ${file}`);
  return parsed.config;
}

const appVars = readWranglerConfig(path.join(appDir, "wrangler.jsonc")).env?.[deployEnv]?.vars;
const authUrl: unknown = appVars?.BETTER_AUTH_URL;
const gatewayBaseUrl: unknown = appVars?.GATEWAY_BASE_URL;
const teamDomain: unknown = appVars?.ACCESS_TEAM_DOMAIN;
const webRoutes: unknown = readWranglerConfig(path.join(appDir, "../web/wrangler.jsonc")).env?.[deployEnv]?.routes;

/** 列出某個 Worker（以它的目錄為 cwd）在該環境已設定的 secret 名稱；失敗就中止部署。 */
function listSecretNames(workerDir: string, label: string): string[] {
  const listed = Bun.spawnSync(["bunx", "wrangler", "secret", "list", "--env", deployEnv, "--format", "json"], {
    cwd: workerDir,
    stderr: "pipe",
  });
  if (listed.exitCode !== 0) {
    console.error(`::error::無法列出 ${label} ${deployEnv} 的 secrets（Worker 尚未建立或 API token 權限不足？）`);
    console.error(listed.stderr.toString());
    process.exit(1);
  }
  try {
    return parseSecretList(listed.stdout.toString());
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

const secretNames = listSecretNames(appDir, "App");
const webSecretNames = listSecretNames(path.join(appDir, "../web"), "Web");

const authProblems = checkAuthDeploy({
  deployEnv,
  authUrl: typeof authUrl === "string" ? authUrl : undefined,
  webOrigin: webOriginFromRoutes(webRoutes),
  secretNames,
});
const paymentProblems = checkPaymentDeploy({
  deployEnv,
  gatewayBaseUrl: typeof gatewayBaseUrl === "string" ? gatewayBaseUrl : undefined,
  appSecretNames: secretNames,
  webSecretNames,
});
const accessProblems = checkAccessDeploy({
  deployEnv,
  teamDomain: typeof teamDomain === "string" ? teamDomain : undefined,
  appVarNames: Object.keys(appVars ?? {}),
  secretNames,
});
const problems = [...authProblems, ...paymentProblems, ...accessProblems];
if (problems.length > 0) {
  console.error(
    `::error::${deployEnv} 的顧客登入、付款或管理後台設定有問題，已中止（尚未套用 migration）：${problems.join("；")}。` +
      `BETTER_AUTH_URL 與 GATEWAY_BASE_URL 填在 apps/app/wrangler.jsonc（BETTER_AUTH_URL 須等於 apps/web/wrangler.jsonc 的自訂網域），` +
      `secret 用 \`wrangler secret put <名稱> --env ${deployEnv}\` 設定（App 於 apps/app、Web 於 apps/web），見 README「顧客登入」與「付款」。`,
  );
  process.exit(1);
}
console.log(`${deployEnv} 的顧客登入與付款設定齊全。`);
