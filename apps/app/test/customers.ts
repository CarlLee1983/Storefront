import { env } from "cloudflare:workers";
import { loginWith } from "./oauth-stub";

/**
 * 走完整登入流程建立一位顧客，回傳可直接當作 RPC 第一個參數的 session cookie。
 * Better Auth 的登入限流會擋住短時間內的連續登入，所以每次登入前清空限流紀錄（只影響測試）。
 */
export async function signInCustomer(sub: string, name = sub): Promise<string> {
  await env.DB.prepare("DELETE FROM rate_limit").run();
  const login = await loginWith("google", { sub, email: `${sub}@example.com`, email_verified: true, name });
  if (!login.sessionCookie) throw new Error(`顧客 ${sub} 登入失敗`);
  return login.sessionCookie;
}
