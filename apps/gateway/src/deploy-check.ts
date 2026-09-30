import { z } from "zod";

/** 閘道部署前必須已用 `wrangler secret put` 設定的 Worker secrets。 */
export const REQUIRED_SECRETS = ["GATEWAY_API_KEY", "GATEWAY_WEBHOOK_SECRET"] as const;

const secretListSchema = z.array(z.object({ name: z.string() }));

/** 解析 `wrangler secret list --format json` 的輸出，回傳 secret 名稱（值是 write-only，只能檢查名稱）。 */
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

export const missingSecrets = (secretNames: string[]): string[] =>
  REQUIRED_SECRETS.filter((name) => !secretNames.includes(name));
