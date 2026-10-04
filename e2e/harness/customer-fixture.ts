import { execFileSync } from "node:child_process";
import { BASE_URL } from "./constants";

const DAY_MS = 86_400_000;
/** wrangler dev 內建的 Local Explorer：由執行 App 的同一個 workerd 行程執行 SQL（D1 binding 的 raw 查詢）。 */
const D1_RAW_URL = `${BASE_URL}/cdn-cgi/local/explorer/api/d1/database/DB/raw`;

/**
 * 對 E2E 專用的 App D1 執行 SQL，只用來安排顧客等前置資料，斷言一律走畫面。
 * 經受測伺服器自己的 Local Explorer 端點寫入，不從別的行程直接開 SQLite 檔：外部行程的寫入會與 workerd 內的
 * 查詢爭用檔案鎖，讓伺服器的 D1 查詢以 internal error 失敗、夾具本身也會 SQLITE_BUSY；從行程內寫入就沒有跨行程爭用。
 * 依賴兩件事（wrangler 升級時先檢查）：(1) Local Explorer 是實驗功能，serve.ts 以 X_LOCAL_EXPLORER=true 明確開啟，端點路徑與回應格式可能改變；
 * (2) URL 裡的 D1 識別 `DB` 是 App 的 D1 binding 名稱（Local Explorer 以 `database_id ?? binding` 當 namespace，
 * 這個 repo 的 wrangler.jsonc 沒有設 database_id，所以是 binding 名稱；若之後設了 database_id，這裡要跟著改）。
 * 維持同步（用 curl）：夾具在測試裡是同步呼叫，且一次呼叫的多個語句在同一個請求內依序執行。
 */
export function writeFixture(sql: string): void {
  const output = execFileSync(
    "curl",
    ["--silent", "--show-error", "--max-time", "30", "--request", "POST", "--header", "content-type: application/json", "--data-binary", "@-", "--write-out", "\n%{http_code}", D1_RAW_URL],
    { input: JSON.stringify({ sql }), encoding: "utf8" },
  );
  const separator = output.lastIndexOf("\n");
  const status = Number(output.slice(separator + 1));
  const body = output.slice(0, separator);
  if (status !== 200) throw new Error(`夾具 SQL 執行失敗（HTTP ${status}）：${body}`);
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
