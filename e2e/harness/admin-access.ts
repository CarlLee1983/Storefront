import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { LOCAL_TEAM_DOMAIN } from "@storefront/app/access";
import { generateDevKeys, signAccessJwt } from "@storefront/app/dev-keys";
import { ADMIN_ACCESS_AUD, ADMIN_EMAIL } from "./constants";

const KID = "storefront-e2e-key";
const TOKEN_LIFETIME_SECONDS = 24 * 3600;
/** serve.ts 簽好 JWT 後寫在這裡，Playwright worker（另一個行程）從這裡讀；目錄每次執行都重建。 */
const TOKEN_FILE = resolve(import.meta.dirname, "../../.wrangler/e2e/admin-access-jwt");

/**
 * 產生 Access 測試用的金鑰與管理者 JWT（與 `apps/app/scripts/admin-dev-token.ts` 相同做法），
 * 把 JWT 寫入 TOKEN_FILE，回傳要附加到 App `.dev.vars` 的 Access 設定（值以單引號包起來）。
 */
export async function createAdminAccess(): Promise<string[]> {
  const { privateKey, publicJwk } = await generateDevKeys(KID);
  const token = await signAccessJwt({ privateKey, kid: KID, email: ADMIN_EMAIL, audience: ADMIN_ACCESS_AUD, lifetimeSeconds: TOKEN_LIFETIME_SECONDS });
  mkdirSync(dirname(TOKEN_FILE), { recursive: true });
  writeFileSync(TOKEN_FILE, token);
  return [
    `ACCESS_TEAM_DOMAIN='${LOCAL_TEAM_DOMAIN}'`,
    `ACCESS_AUD='${ADMIN_ACCESS_AUD}'`,
    `ACCESS_JWKS_JSON='${JSON.stringify({ keys: [publicJwk] })}'`,
  ];
}

/** 管理者瀏覽器 context 的額外 header：與 Cloudflare Access 在 production 帶入的相同，Web 原樣轉交給 App 驗簽。 */
export function adminAccessHeaders(): Record<string, string> {
  try {
    return { "Cf-Access-Jwt-Assertion": readFileSync(TOKEN_FILE, "utf8") };
  } catch (cause) {
    throw new Error(`讀不到管理者 Access JWT（${TOKEN_FILE}）：serve.ts 尚未產生，或 E2E 狀態目錄已被清掉`, { cause });
  }
}
