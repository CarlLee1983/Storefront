/** 部署前檢查用（`scripts/check-auth-deploy.ts`），不被 Worker 引用。 */
import { z } from "zod";
import { AUTH_SECRET_NAMES } from "./config";

export type DeployEnv = "preview" | "production";

/** wrangler.jsonc 尚未填入真實值時的佔位前綴。 */
const PLACEHOLDER = "REPLACE_WITH_";

const routesSchema = z.array(
  z.object({ pattern: z.string(), custom_domain: z.boolean().optional() }).loose(),
);

/**
 * 從 `apps/web/wrangler.jsonc` 某環境的 `routes` 取出 Web 的公開 origin（第一個 custom_domain 的網域）。
 * `BETTER_AUTH_URL` 必須與它完全相等，所以網域只在 Web 的設定填一次；沒有可用的網域時回 undefined。
 */
export function webOriginFromRoutes(routes: unknown): string | undefined {
  const parsed = routesSchema.safeParse(routes);
  if (!parsed.success) return undefined;
  const route = parsed.data.find((r) => r.custom_domain === true);
  return route ? `https://${route.pattern}` : undefined;
}

/**
 * 回傳部署後會讓顧客登入不可用的問題。secret 的值是 write-only，讀不到，所以只能檢查名稱是否存在；
 * `BETTER_AUTH_URL` 是純文字 var，可以檢查值：OAuth 的 redirect_uri 由它組成，
 * 填錯（例如貼到別的環境、多一個結尾斜線）登入只會在 provider 端失敗。
 */
export function checkAuthDeploy(input: {
  deployEnv: DeployEnv;
  authUrl: string | undefined;
  webOrigin: string | undefined;
  secretNames: readonly string[];
}): string[] {
  const problems: string[] = [];
  if (!input.webOrigin || input.webOrigin.includes(PLACEHOLDER)) {
    problems.push(`apps/web/wrangler.jsonc 的 env.${input.deployEnv}.routes 尚未填入自訂網域`);
  } else if (!input.authUrl) {
    problems.push("缺少 BETTER_AUTH_URL");
  } else if (input.authUrl !== input.webOrigin) {
    problems.push(`BETTER_AUTH_URL 應為 ${input.webOrigin}，目前是 ${input.authUrl}`);
  }
  for (const name of AUTH_SECRET_NAMES) {
    if (!input.secretNames.includes(name)) problems.push(`缺少 ${name}`);
  }
  return problems;
}

const secretListSchema = z.array(z.object({ name: z.string() }));

/** 解析 `wrangler secret list --format json` 的輸出；格式不符就丟錯，不能當作「沒有任何 secret」。 */
export function parseSecretList(output: string): string[] {
  let json: unknown;
  try {
    json = JSON.parse(output);
  } catch {
    throw new Error("wrangler secret list 的輸出不是 JSON");
  }
  const parsed = secretListSchema.safeParse(json);
  if (!parsed.success) throw new Error("wrangler secret list 的輸出格式不符預期（應為 [{ name }]）");
  return parsed.data.map((secret) => secret.name);
}
