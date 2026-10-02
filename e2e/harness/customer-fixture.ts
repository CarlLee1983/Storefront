import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");
const DAY_MS = 86_400_000;

/** 對 E2E 專用的 App D1 執行 SQL（與 serve.ts 建立的狀態與設定相同），只用來安排顧客等前置資料，斷言一律走畫面。 */
export function writeFixture(sql: string): void {
  const config = resolve(ROOT, ".wrangler/e2e/app/wrangler.json");
  const database = JSON.parse(readFileSync(config, "utf8")).d1_databases[0].database_name as string;
  execFileSync("bunx", ["wrangler", "d1", "execute", database, "--local", "-c", config, "--persist-to", resolve(ROOT, ".wrangler/e2e/state-app"), "--command", sql], { cwd: resolve(ROOT, "apps/app"), stdio: "pipe" });
}

/** 新增一位有效 session 的顧客；`verifiedEmail` 有給就同時安排一筆已驗證的聯絡 email（結帳的前提），沒給則是尚未驗證的新顧客。 */
export function createCustomer(name: string, verifiedEmail?: string): { id: string; token: string } {
  const id = crypto.randomUUID();
  const token = `fixture-${id}`;
  const now = Date.now();
  const contact = verifiedEmail
    ? ` INSERT INTO contact_verifications (customer_id, email, token, created_at, expires_at, verified_at) VALUES ('${id}', '${verifiedEmail}', 'fixture-contact-${id}', ${now}, ${now + DAY_MS}, ${now});`
    : "";
  writeFixture(`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES ('${id}', '${name}', '${id}@members.storefront.invalid', 0, ${now}, ${now}); INSERT INTO session (id, expires_at, token, created_at, updated_at, user_id) VALUES ('${id}', ${now + DAY_MS}, '${token}', ${now}, ${now}, '${id}');${contact}`);
  return { id, token };
}
