// 部署前檢查：閘道缺少 GATEWAY_API_KEY 或 GATEWAY_WEBHOOK_SECRET 時，部署出去的每個請求都會 503，所以在 migration 之前先擋下。
// 讀 `wrangler secret list --env <env>`（值是 write-only，只能檢查名稱存在；需要 CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID）。
// 用法：bun scripts/check-gateway-deploy.ts <preview|production>
import path from "node:path";
import { missingSecrets, parseSecretList } from "../src/deploy-check";

const deployEnv = process.argv[2];
if (deployEnv !== "preview" && deployEnv !== "production") {
  console.error("用法：bun scripts/check-gateway-deploy.ts <preview|production>");
  process.exit(2);
}

const listed = Bun.spawnSync(["bunx", "wrangler", "secret", "list", "--env", deployEnv, "--format", "json"], {
  cwd: path.resolve(import.meta.dirname, ".."),
  stderr: "pipe",
});
if (listed.exitCode !== 0) {
  console.error(`::error::無法列出 gateway ${deployEnv} 的 secrets（Worker 尚未建立或 API token 權限不足？）`);
  console.error(listed.stderr.toString());
  process.exit(1);
}

let names: string[];
try {
  names = parseSecretList(listed.stdout.toString());
} catch (error) {
  console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const missing = missingSecrets(names);
if (missing.length > 0) {
  console.error(
    `::error::gateway ${deployEnv} 缺少設定：${missing.join("、")}，已中止（尚未套用 migration）。` +
      `於 apps/gateway 執行 \`wrangler secret put <名稱> --env ${deployEnv}\` 設定，見 README「模擬金流閘道」。`,
  );
  process.exit(1);
}
console.log(`gateway ${deployEnv} 的必要設定齊全。`);
