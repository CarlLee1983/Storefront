import { env, exports } from "cloudflare:workers";
import { loginWith } from "./oauth-stub";

interface SignInOptions {
  /** 預設為這位顧客直接寫入一個已驗證的聯絡 email（結帳的前提）；傳 false 則維持剛登入、尚未驗證的狀態。 */
  verifiedContact?: boolean;
}

/**
 * 走完整登入流程建立一位顧客，回傳可直接當作 RPC 第一個參數的 session cookie。
 * Better Auth 的登入限流會擋住短時間內的連續登入，所以每次登入前清空限流紀錄（只影響測試）。
 * 聯絡 email 的驗證流程由 contact 相關測試走 RPC 驗證；其他測試只需要「已驗證」這個前提，所以直接寫入。
 */
export async function signInCustomer(sub: string, name = sub, { verifiedContact = true }: SignInOptions = {}): Promise<string> {
  await env.DB.prepare("DELETE FROM rate_limit").run();
  const login = await loginWith("google", { sub, email: `${sub}@example.com`, email_verified: true, name });
  if (!login.sessionCookie) throw new Error(`顧客 ${sub} 登入失敗`);
  if (verifiedContact) {
    const { customer } = await exports.default.getCustomerSession(login.sessionCookie);
    if (!customer) throw new Error(`顧客 ${sub} 取不到 session`);
    await seedVerifiedContact(customer.customerId, `contact-${sub}@example.com`);
  }
  return login.sessionCookie;
}

/** 直接寫入一筆已驗證的聯絡 email（測試安排前置狀態用）。 */
export async function seedVerifiedContact(customerId: string, email: string, verifiedAt = 1): Promise<void> {
  await env.DB
    .prepare("INSERT OR IGNORE INTO contact_verifications (customer_id, email, token, created_at, expires_at, verified_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(customerId, email, `seed-${customerId}-${email}-${verifiedAt}`, verifiedAt, verifiedAt + 1, verifiedAt)
    .run();
}
