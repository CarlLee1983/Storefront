// 唯讀部署前檢查，必須在 migration 之前執行：0007 會下架沒有圖片的既有商品。
// 不建立 bucket、不變更權限、不套 migration。
// 用法：bun scripts/check-images-deploy.ts <preview|production>
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { checkImagesDeploy } from "../src/images/deploy-check";

const deployEnv = process.argv[2];
if (deployEnv !== "preview" && deployEnv !== "production") {
  console.error("用法：bun scripts/check-images-deploy.ts <preview|production>");
  process.exit(2);
}
const appDir = path.resolve(import.meta.dirname, "..");

function readBuckets(file: string): unknown {
  const parsed = ts.parseConfigFileTextToJson(file, readFileSync(file, "utf8"));
  if (parsed.error) throw new Error(`無法解析 ${file}`);
  return parsed.config?.env?.[deployEnv!]?.r2_buckets;
}

try {
  const problems = checkImagesDeploy({
    deployEnv,
    appBuckets: readBuckets(path.join(appDir, "wrangler.jsonc")),
    webBuckets: readBuckets(path.join(appDir, "../web/wrangler.jsonc")),
  });
  if (problems.length) throw new Error(problems.join("；"));
  const bucket = `storefront-product-images-${deployEnv}`;
  const info = Bun.spawnSync(["bunx", "wrangler", "r2", "bucket", "info", bucket, "--json"], { cwd: appDir, stderr: "pipe" });
  if (info.exitCode !== 0) {
    console.error(info.stderr.toString());
    throw new Error(`無法讀取 R2 bucket ${bucket}；請確認 bucket 已建立且部署 API token 有所需權限`);
  }
  console.log(`${deployEnv} 的 App / Web PRODUCT_IMAGES 設定一致，R2 bucket ${bucket} 存在且可讀取。`);
} catch (error) {
  console.error(`::error::商品圖片部署前檢查失敗，已中止（尚未套用 migration）：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
