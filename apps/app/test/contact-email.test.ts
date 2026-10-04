import { exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { setNow } from "./clock";
import { signInCustomer } from "./customers";
import { resetDb } from "./db";

const app = exports.default;
const NOW = Date.UTC(2026, 9, 3, 2, 0, 0);
const DAY = 86_400_000;

beforeEach(async () => {
  await resetDb();
  setNow(NOW);
});

/** 顧客的信箱裡最新一封信的驗證憑證（只有顧客自己讀得到）。 */
async function latestToken(cookie: string): Promise<string> {
  const list = await app.listMyMail(cookie);
  if (!list.ok || !list.data[0]) throw new Error("信箱沒有信");
  const mail = await app.getMyMail(cookie, { messageId: list.data[0].id });
  if (!mail.ok || !mail.data.verification || mail.data.verification.status !== "pending") throw new Error("信裡沒有可用的驗證連結");
  return mail.data.verification.token;
}

describe("聯絡 email 驗證", () => {
  it("剛登入的顧客沒有聯絡 email：登入識別 email 不當作已驗證的聯絡資料", async () => {
    const cookie = await signInCustomer("alice", "Alice", { verifiedContact: false });

    expect(await app.getMyContact(cookie)).toEqual({ ok: true, data: { verifiedEmail: null, pending: null } });
  });

  it("送出新地址後在自己的信箱收到驗證信，點驗證後才成為已驗證聯絡 email", async () => {
    const cookie = await signInCustomer("alice", "Alice", { verifiedContact: false });

    const requested = await app.requestContactEmail(cookie, { email: "  Alice@Example.com " });
    expect(requested).toMatchObject({ ok: true, data: { delivered: true } });
    expect(await app.getMyContact(cookie)).toEqual({
      ok: true,
      data: { verifiedEmail: null, pending: { email: "alice@example.com", expiresAt: NOW + DAY } },
    });

    const token = await latestToken(cookie);
    expect(await app.verifyContactEmail(cookie, { token })).toEqual({ ok: true, data: { email: "alice@example.com" } });
    expect(await app.getMyContact(cookie)).toEqual({ ok: true, data: { verifiedEmail: "alice@example.com", pending: null } });
  });

  it("驗證信寄到待驗證的地址，並保留實際收件地址", async () => {
    const cookie = await signInCustomer("alice", "Alice", { verifiedContact: false });
    await app.requestContactEmail(cookie, { email: "alice@example.com" });

    const list = await app.listMyMail(cookie);
    expect(list).toMatchObject({ ok: true, data: [{ kind: "contact_verification", recipientAddress: "alice@example.com", receivedAt: NOW }] });
  });

  it("格式不合的 email 被拒絕，不產生信件", async () => {
    const cookie = await signInCustomer("alice", "Alice", { verifiedContact: false });

    expect(await app.requestContactEmail(cookie, { email: "not-an-email" })).toMatchObject({ ok: false, reason: "invalid_input", fields: { email: expect.any(Array) } });
    expect(await app.listMyMail(cookie)).toEqual({ ok: true, data: [] });
  });

  it("憑證錯誤、過期、被新請求取代都不能驗證，且不影響既有已驗證地址", async () => {
    const cookie = await signInCustomer("alice", "Alice", { verifiedContact: false });
    expect(await app.verifyContactEmail(cookie, { token: "no-such-token" })).toEqual({ ok: false, reason: "invalid_token" });

    await app.requestContactEmail(cookie, { email: "old@example.com" });
    const oldToken = await latestToken(cookie);
    await app.requestContactEmail(cookie, { email: "new@example.com" });
    // 第二次請求取代第一次
    expect(await app.verifyContactEmail(cookie, { token: oldToken })).toEqual({ ok: false, reason: "verification_closed" });

    const newToken = await latestToken(cookie);
    setNow(NOW + DAY + 1);
    expect(await app.verifyContactEmail(cookie, { token: newToken })).toEqual({ ok: false, reason: "verification_closed" });
    expect(await app.getMyContact(cookie)).toEqual({ ok: true, data: { verifiedEmail: null, pending: null } });
  });

  it("同一個驗證連結重複點擊是冪等的", async () => {
    const cookie = await signInCustomer("alice", "Alice", { verifiedContact: false });
    await app.requestContactEmail(cookie, { email: "alice@example.com" });
    const token = await latestToken(cookie);

    await app.verifyContactEmail(cookie, { token });
    expect(await app.verifyContactEmail(cookie, { token })).toEqual({ ok: true, data: { email: "alice@example.com" } });
  });
});

describe("頻率限制與舊憑證", () => {
  it("同一顧客 10 分鐘內最多 5 筆驗證請求，超過回 too_many_requests；視窗過後可再送", async () => {
    const cookie = await signInCustomer("alice", "Alice", { verifiedContact: false });
    for (let i = 0; i < 5; i += 1) expect(await app.requestContactEmail(cookie, { email: `a${i}@example.com` })).toMatchObject({ ok: true });

    expect(await app.requestContactEmail(cookie, { email: "a5@example.com" })).toEqual({ ok: false, reason: "too_many_requests" });

    setNow(NOW + 10 * 60 * 1000 + 1);
    expect(await app.requestContactEmail(cookie, { email: "a5@example.com" })).toMatchObject({ ok: true });
  });

  it("已驗證的舊連結被之後的驗證取代後不再成功", async () => {
    const cookie = await signInCustomer("alice", "Alice", { verifiedContact: false });
    await app.requestContactEmail(cookie, { email: "old@example.com" });
    const oldToken = await latestToken(cookie);
    await app.verifyContactEmail(cookie, { token: oldToken });
    setNow(NOW + 1000);
    await app.requestContactEmail(cookie, { email: "new@example.com" });
    const newToken = await latestToken(cookie);
    await app.verifyContactEmail(cookie, { token: newToken });

    expect(await app.verifyContactEmail(cookie, { token: oldToken })).toEqual({ ok: false, reason: "verification_closed" });
    expect(await app.verifyContactEmail(cookie, { token: newToken })).toEqual({ ok: true, data: { email: "new@example.com" } });
    expect(await app.getMyContact(cookie)).toMatchObject({ ok: true, data: { verifiedEmail: "new@example.com" } });
  });
});

describe("更換聯絡 email", () => {
  async function verified(cookie: string, email: string) {
    await app.requestContactEmail(cookie, { email });
    await app.verifyContactEmail(cookie, { token: await latestToken(cookie) });
  }

  it("未驗證的新地址不取代既有已驗證地址，驗證後才換", async () => {
    const cookie = await signInCustomer("alice", "Alice", { verifiedContact: false });
    await verified(cookie, "old@example.com");

    await app.requestContactEmail(cookie, { email: "new@example.com" });
    expect(await app.getMyContact(cookie)).toMatchObject({ ok: true, data: { verifiedEmail: "old@example.com", pending: { email: "new@example.com" } } });

    setNow(NOW + 1000);
    await app.verifyContactEmail(cookie, { token: await latestToken(cookie) });
    expect(await app.getMyContact(cookie)).toEqual({ ok: true, data: { verifiedEmail: "new@example.com", pending: null } });
  });

  it("換址後歷史信件保持原收件地址，不被改寫", async () => {
    const cookie = await signInCustomer("alice", "Alice", { verifiedContact: false });
    await verified(cookie, "old@example.com");
    const before = await app.listMyMail(cookie);
    if (!before.ok) throw new Error("讀信失敗");
    const oldMessageId = before.data[0]!.id;

    setNow(NOW + 1000);
    await verified(cookie, "new@example.com");

    const mail = await app.getMyMail(cookie, { messageId: oldMessageId });
    expect(mail).toMatchObject({ ok: true, data: { id: oldMessageId, deliveries: [{ recipientAddress: "old@example.com" }], verification: { status: "verified" } } });
    const after = await app.listMyMail(cookie);
    expect(after).toMatchObject({ ok: true, data: [{ recipientAddress: "new@example.com" }, { id: oldMessageId, recipientAddress: "old@example.com" }] });
  });

  it("要求驗證已是目前已驗證地址的 email 回 already_verified", async () => {
    const cookie = await signInCustomer("alice", "Alice", { verifiedContact: false });
    await verified(cookie, "alice@example.com");

    expect(await app.requestContactEmail(cookie, { email: "ALICE@example.com" })).toEqual({ ok: false, reason: "already_verified" });
  });
});

describe("身分與隔離", () => {
  it("兩位顧客驗證同一個 email 互不影響，也看不到對方的信", async () => {
    const google = await signInCustomer("same-person", "Google person", { verifiedContact: false });
    const line = await signInCustomer("line-person", "LINE person", { verifiedContact: false });
    await app.requestContactEmail(google, { email: "me@example.com" });
    await app.verifyContactEmail(google, { token: await latestToken(google) });

    expect(await app.getMyContact(line)).toEqual({ ok: true, data: { verifiedEmail: null, pending: null } });
    expect(await app.listMyMail(line)).toEqual({ ok: true, data: [] });
  });

  it("顧客讀不到別人的信，也不能用別人的驗證憑證", async () => {
    const alice = await signInCustomer("alice", "Alice", { verifiedContact: false });
    const bob = await signInCustomer("bob", "Bob", { verifiedContact: false });
    await app.requestContactEmail(alice, { email: "alice@example.com" });
    const aliceToken = await latestToken(alice);
    const list = await app.listMyMail(alice);
    if (!list.ok) throw new Error("讀信失敗");
    const aliceMessageId = list.data[0]!.id;

    expect(await app.listMyMail(bob)).toEqual({ ok: true, data: [] });
    expect(await app.getMyMail(bob, { messageId: aliceMessageId })).toEqual({ ok: false, reason: "mail_not_found" });
    expect(await app.verifyContactEmail(bob, { token: aliceToken })).toEqual({ ok: false, reason: "invalid_token" });
    expect(await app.getMyContact(bob)).toEqual({ ok: true, data: { verifiedEmail: null, pending: null } });
    // Alice 的請求沒有被 Bob 消耗
    expect(await app.verifyContactEmail(alice, { token: aliceToken })).toEqual({ ok: true, data: { email: "alice@example.com" } });
  });

  it("沒有有效 session 的所有顧客方法都回 unauthorized", async () => {
    const unauthorized = { ok: false, reason: "unauthorized" };
    expect(await app.getMyContact("")).toEqual(unauthorized);
    expect(await app.requestContactEmail("", { email: "a@example.com" })).toEqual(unauthorized);
    expect(await app.verifyContactEmail("", { token: "t" })).toEqual(unauthorized);
    expect(await app.listMyMail("")).toEqual(unauthorized);
    expect(await app.getMyMail("", { messageId: 1 })).toEqual(unauthorized);
  });
});
