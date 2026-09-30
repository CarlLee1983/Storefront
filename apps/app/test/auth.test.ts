import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDb } from "./db";
import { loginWith, ORIGIN } from "./oauth-stub";

const app = exports.default;

async function userEmails(): Promise<string[]> {
  const { results } = await env.DB.prepare('SELECT email FROM "user" ORDER BY email').all<{
    email: string;
  }>();
  return results.map((row) => row.email);
}

/** getCustomerSession 回傳 { customer, setCookies }；多數測試只關心 customer。 */
async function customerOf(cookie: string) {
  return (await app.getCustomerSession(cookie)).customer;
}

async function sessionCount(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM session").first<{ n: number }>();
  return row!.n;
}

describe("顧客登入（LINE 與 Google）", () => {
  beforeEach(resetDb);
  afterEach(() => vi.restoreAllMocks());

  it("Google 登入成功，建立顧客並取得 session", async () => {
    const login = await loginWith("google", {
      sub: "g-1",
      email: "alice@example.com",
      email_verified: true,
      name: "Alice",
    });

    expect(login.status).toBe(302);
    expect(login.location).toBe("/");
    expect(login.sessionCookie).toBeDefined();
    expect(await userEmails()).toEqual(["alice@example.com"]);
    expect(await customerOf(login.sessionCookie!)).toMatchObject({ name: "Alice" });
  });

  it("登入後回到發起時指定的 callbackURL（例如 /checkout）", async () => {
    const login = await loginWith("google", { sub: "g-1", email: "a@example.com", name: "Alice" }, "/checkout");

    expect(login.status).toBe(302);
    expect(login.location).toBe("/checkout");
  });

  it("LINE 沒有提供 email 時登入不被拒絕，顧客 email 是 placeholder", async () => {
    const login = await loginWith("line", { sub: "U2", name: "Bob" });

    expect(login.status).toBe(302);
    expect(login.location).toBe("/");
    expect(login.sessionCookie).toBeDefined();
    expect(await userEmails()).toEqual(["line-u2@customers.storefront.invalid"]);
  });

  it("LINE 有提供 email 時仍不儲存，一律用 placeholder", async () => {
    const login = await loginWith("line", { sub: "U3", email: "carol@example.com", name: "Carol" });

    expect(login.sessionCookie).toBeDefined();
    expect(await userEmails()).toEqual(["line-u3@customers.storefront.invalid"]);
  });

  it("同一人先 Google 後 LINE（同一個真實 email）成為兩位顧客，不自動合併", async () => {
    const google = await loginWith("google", {
      sub: "g-1",
      email: "same@example.com",
      email_verified: true,
      name: "Same",
    });
    const line = await loginWith("line", { sub: "U1", email: "same@example.com", name: "Same" });

    expect(line.sessionCookie).toBeDefined();
    expect(await userEmails()).toEqual(["line-u1@customers.storefront.invalid", "same@example.com"]);
    const [googleCustomer, lineCustomer] = await Promise.all([
      customerOf(google.sessionCookie!),
      customerOf(line.sessionCookie!),
    ]);
    expect(googleCustomer!.customerId).not.toBe(lineCustomer!.customerId);
  });

  it("同一人先 LINE 後 Google（同一個真實 email）同樣成為兩位顧客", async () => {
    await loginWith("line", { sub: "U1", email: "same@example.com", name: "Same" });
    const google = await loginWith("google", {
      sub: "g-1",
      email: "same@example.com",
      email_verified: true,
      name: "Same",
    });

    expect(google.sessionCookie).toBeDefined();
    expect(await userEmails()).toEqual(["line-u1@customers.storefront.invalid", "same@example.com"]);
  });

  it("同一個 LINE 身分再次登入回到同一位顧客", async () => {
    const first = await loginWith("line", { sub: "U1", name: "Dan" });
    const second = await loginWith("line", { sub: "U1", name: "Dan" });

    expect(await userEmails()).toEqual(["line-u1@customers.storefront.invalid"]);
    expect((await customerOf(second.sessionCookie!))!.customerId).toBe(
      (await customerOf(first.sessionCookie!))!.customerId,
    );
  });
});

describe("LINE 身分缺少 sub", () => {
  beforeEach(resetDb);
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ["沒有 sub", { name: "NoSub" }],
    ["sub 是空字串", { sub: "", name: "Empty" }],
    ["sub 不是字串", { sub: 42, name: "Num" }],
  ])("%s：登入被拒絕，不建立顧客，也不產生 line-undefined 的 email", async (_label, profile) => {
    const login = await loginWith("line", profile);

    expect(login.sessionCookie).toBeUndefined();
    expect(await userEmails()).toEqual([]);
    expect(await sessionCount()).toBe(0);
  });
});

describe("OAuth token 加密", () => {
  beforeEach(resetDb);
  afterEach(() => vi.restoreAllMocks());

  it("account 表裡的 access token 不是 provider 回傳的明文", async () => {
    await loginWith("google", { sub: "g-1", email: "a@example.com", name: "Alice" });

    const row = await env.DB.prepare("SELECT access_token FROM account").first<{
      access_token: string | null;
    }>();
    expect(row!.access_token).toBeTruthy();
    expect(row!.access_token).not.toBe("access-token");
  });
});

describe("rate limit", () => {
  beforeEach(resetDb);

  const signIn = (headers: Record<string, string>) =>
    app.fetch(
      new Request(`${ORIGIN}/api/auth/sign-in/social`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN, ...headers },
        body: JSON.stringify({ provider: "google", callbackURL: "/" }),
      }),
    );

  async function rateLimitKeys(): Promise<string[]> {
    const { results } = await env.DB.prepare("SELECT key FROM rate_limit ORDER BY key").all<{
      key: string;
    }>();
    return results.map((row) => row.key);
  }

  it("計數存在 D1，key 用 cf-connecting-ip，不受 X-Forwarded-For 影響", async () => {
    await signIn({ "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "198.51.100.1" });

    expect(await rateLimitKeys()).toEqual(["203.0.113.7|/sign-in/social"]);
  });

  it("同一個 cf-connecting-ip 換 X-Forwarded-For 也擋得住（sign-in 10 秒內 3 次）", async () => {
    const statuses: number[] = [];
    for (const forwarded of ["1.1.1.1", "2.2.2.2", "3.3.3.3", "4.4.4.4"]) {
      const response = await signIn({ "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": forwarded });
      statuses.push(response.status);
    }

    expect(statuses).toEqual([200, 200, 200, 429]);
    // 不同的 cf-connecting-ip 有自己的額度
    expect((await signIn({ "cf-connecting-ip": "203.0.113.8" })).status).toBe(200);
  });
});

describe("帳號連結關閉", () => {
  beforeEach(resetDb);
  afterEach(() => vi.restoreAllMocks());

  // 單靠 accountLinking 關閉就足以擋下 email 合併：Google 的 email 是已驗證的
  it("同一個 email、不同 Google 身分再登入：被拒絕，不併入第一位顧客", async () => {
    await loginWith("google", {
      sub: "g-1",
      email: "same@example.com",
      email_verified: true,
      name: "First",
    });
    const second = await loginWith("google", {
      sub: "g-2",
      email: "same@example.com",
      email_verified: true,
      name: "Second",
    });

    expect(second.sessionCookie).toBeUndefined();
    expect(second.location).toContain("account_not_linked");
    expect(await userEmails()).toEqual(["same@example.com"]);
    const accounts = await env.DB.prepare("SELECT COUNT(*) AS n FROM account").first<{ n: number }>();
    expect(accounts!.n).toBe(1);
  });
});

describe("session", () => {
  beforeEach(resetDb);
  afterEach(() => vi.restoreAllMocks());

  it("沒有 cookie 或 cookie 無效時不是顧客", async () => {
    expect(await app.getCustomerSession("")).toEqual({ customer: null, setCookies: [] });
    expect(await app.getCustomerSession("better-auth.session_token=bogus")).toEqual({
      customer: null,
      setCookies: [],
    });
  });

  it("只回傳 Web 需要的欄位，不含 session token", async () => {
    const login = await loginWith("google", {
      sub: "g-1",
      email: "alice@example.com",
      email_verified: true,
      name: "Alice",
    });

    const customer = await customerOf(login.sessionCookie!);
    expect(Object.keys(customer!).sort()).toEqual(["customerId", "expiresAt", "name"]);
    expect(typeof customer!.expiresAt).toBe("number");
  });

  it("session 逾 updateAge 被延長時，RPC 一併回傳要送給瀏覽器的 Set-Cookie", async () => {
    const login = await loginWith("google", { sub: "g-1", email: "a@example.com", name: "Alice" });
    const fresh = await app.getCustomerSession(login.sessionCookie!);
    expect(fresh.setCookies).toEqual([]);

    // 把到期日拉近到超過 1 天（預設 updateAge）沒有延長的程度
    const nearExpiry = Date.now() + 5 * 24 * 3600_000;
    await env.DB.prepare("UPDATE session SET expires_at = ?").bind(nearExpiry).run();

    const refreshed = await app.getCustomerSession(login.sessionCookie!);
    expect(refreshed.customer).not.toBeNull();
    expect(refreshed.setCookies.some((c: string) => c.startsWith("better-auth.session_token="))).toBe(true);
    expect(refreshed.customer!.expiresAt).toBeGreaterThan(nearExpiry);
  });

  it("登出後 session 失效，且只刪除該顧客的 session", async () => {
    const alice = await loginWith("google", { sub: "g-1", email: "a@example.com", name: "Alice" });
    const bob = await loginWith("line", { sub: "U2", name: "Bob" });
    expect(await sessionCount()).toBe(2);

    const response = await app.fetch(
      new Request(`${ORIGIN}/api/auth/sign-out`, {
        method: "POST",
        headers: { cookie: alice.sessionCookie!, origin: ORIGIN },
      }),
    );

    expect(response.status).toBe(200);
    expect(await customerOf(alice.sessionCookie!)).toBeNull();
    expect(await customerOf(bob.sessionCookie!)).not.toBeNull();
    expect(await sessionCount()).toBe(1);
  });
});

describe("App Worker 的 HTTP 入口", () => {
  it("只處理 /api/auth/，其他路徑一律 404", async () => {
    const response = await app.fetch(new Request(`${ORIGIN}/admin`));
    expect(response.status).toBe(404);
  });
});

// production 沒有任何測試用的登入路徑（Holdfast ADR 0013）：除了 LINE 與 Google 的社群登入，
// 不存在其他能建立 session 的方式。
describe("沒有測試用或其他的登入路徑", () => {
  beforeEach(resetDb);

  it.each([
    ["email 密碼登入", "/api/auth/sign-in/email", { email: "a@example.com", password: "password1234" }],
    ["email 密碼註冊", "/api/auth/sign-up/email", { email: "a@example.com", password: "password1234", name: "A" }],
    ["測試登入", "/api/auth/test-login", { customerId: "x" }],
  ])("%s 不可用：被拒絕，且不建立 session", async (_label, path, body) => {
    const response = await app.fetch(
      new Request(`${ORIGIN}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify(body),
      }),
    );

    expect(response.ok).toBe(false);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(await sessionCount()).toBe(0);
  });

  it("社群登入只接受 LINE 與 Google", async () => {
    const response = await app.fetch(
      new Request(`${ORIGIN}/api/auth/sign-in/social`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({ provider: "github", callbackURL: "/" }),
      }),
    );

    expect(response.ok).toBe(false);
  });
});
