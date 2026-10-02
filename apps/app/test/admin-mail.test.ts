import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { mintAccessJwt } from "./access";
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

async function adminMail(jwt: string) {
  const result = await app.listMailForAdmin(jwt);
  if (!result.ok) throw new Error("管理員讀不到信件");
  return result.data;
}

async function requestVerification(cookie: string, email: string) {
  const requested = await app.requestContactEmail(cookie, { email });
  if (!requested.ok) throw new Error("要求驗證失敗");
  return requested.data;
}

describe("管理員的信件投遞", () => {
  it("沒有有效 Access JWT 一律 unauthorized，顧客的 cookie 不能當管理員", async () => {
    const cookie = await signInCustomer("alice", "Alice", { verifiedContact: false });
    const unauthorized = { ok: false, reason: "unauthorized" };

    expect(await app.listMailForAdmin("")).toEqual(unauthorized);
    expect(await app.listMailForAdmin(cookie)).toEqual(unauthorized);
    expect(await app.resendMail("", { messageId: 1 })).toEqual(unauthorized);
    expect(await app.setMailDeliveryFailure("", { enabled: true })).toEqual(unauthorized);
  });

  it("看得到每封信的投遞結果與實際收件地址，但看不到驗證連結與內文", async () => {
    const jwt = await mintAccessJwt();
    const cookie = await signInCustomer("alice", "Alice", { verifiedContact: false });
    const { messageId } = await requestVerification(cookie, "alice@example.com");
    const mail = await app.getMyMail(cookie, { messageId });
    if (!mail.ok || mail.data.verification?.status !== "pending") throw new Error("缺驗證連結");

    const listed = await adminMail(jwt);
    expect(listed.failDeliveries).toBe(false);
    expect(listed.messages).toEqual([{
      id: messageId,
      kind: "contact_verification",
      subject: expect.any(String),
      customerId: expect.any(String),
      customerName: "Alice",
      createdAt: NOW,
      deliveries: [{ id: expect.any(Number), recipientAddress: "alice@example.com", status: "delivered", attemptedAt: NOW }],
    }]);
    const raw = JSON.stringify(listed);
    expect(raw).not.toContain(mail.data.verification.token);
    expect(raw).not.toContain(mail.data.body);
  });

  it("開啟投遞失敗後信不會進顧客信箱；關閉並重送後送達，失敗的那次仍留在紀錄", async () => {
    const jwt = await mintAccessJwt();
    const cookie = await signInCustomer("alice", "Alice", { verifiedContact: false });

    expect(await app.setMailDeliveryFailure(jwt, { enabled: true })).toEqual({ ok: true, data: { enabled: true } });
    const { messageId, delivered } = await requestVerification(cookie, "alice@example.com");
    expect(delivered).toBe(false);
    expect(await app.listMyMail(cookie)).toEqual({ ok: true, data: [] });
    expect(await app.getMyMail(cookie, { messageId })).toEqual({ ok: false, reason: "mail_not_found" });
    expect((await adminMail(jwt)).messages[0]!.deliveries).toMatchObject([{ status: "failed" }]);

    // 失敗仍開著，重送也失敗
    expect(await app.resendMail(jwt, { messageId })).toEqual({ ok: true, data: { delivered: false } });

    await app.setMailDeliveryFailure(jwt, { enabled: false });
    setNow(NOW + 1000);
    expect(await app.resendMail(jwt, { messageId })).toEqual({ ok: true, data: { delivered: true } });

    const mail = await app.getMyMail(cookie, { messageId });
    expect(mail).toMatchObject({ ok: true, data: { deliveries: [{ recipientAddress: "alice@example.com", attemptedAt: NOW + 1000 }], verification: { status: "pending" } } });
    const listed = await adminMail(jwt);
    expect(listed.failDeliveries).toBe(false);
    expect(listed.messages[0]!.deliveries.map((delivery) => delivery.status)).toEqual(["failed", "failed", "delivered"]);
  });

  it("重送是同一封信的新投遞，不新增信件；驗證已失效的信不能重送", async () => {
    const jwt = await mintAccessJwt();
    const cookie = await signInCustomer("alice", "Alice", { verifiedContact: false });
    const first = await requestVerification(cookie, "old@example.com");
    await app.resendMail(jwt, { messageId: first.messageId });
    expect((await adminMail(jwt)).messages).toHaveLength(1);

    // 被新請求取代
    await requestVerification(cookie, "new@example.com");
    expect(await app.resendMail(jwt, { messageId: first.messageId })).toEqual({ ok: false, reason: "message_not_resendable" });
    // 過期
    setNow(NOW + DAY + 1);
    const later = await mintAccessJwt();
    const list = await adminMail(later);
    expect(await app.resendMail(later, { messageId: list.messages[0]!.id })).toEqual({ ok: false, reason: "message_not_resendable" });
  });

  it("找不到的信件回 message_not_found；輸入不合法回 invalid_input", async () => {
    const jwt = await mintAccessJwt();

    expect(await app.resendMail(jwt, { messageId: 9999 })).toEqual({ ok: false, reason: "message_not_found" });
    expect(await app.resendMail(jwt, { messageId: "x" })).toMatchObject({ ok: false, reason: "invalid_input" });
    expect(await app.setMailDeliveryFailure(jwt, { enabled: "yes" })).toMatchObject({ ok: false, reason: "invalid_input" });
  });

  it("非驗證信重送到顧客目前已驗證的地址，歷史投遞保持原收件地址", async () => {
    const jwt = await mintAccessJwt();
    const cookie = await signInCustomer("alice", "Alice", { verifiedContact: false });
    await requestVerification(cookie, "old@example.com");
    const token = await tokenOf(cookie);
    await app.verifyContactEmail(cookie, { token });
    // 之後的通知類信件（直接安排一封，投遞到當時的已驗證地址）
    const customer = await app.getCustomerSession(cookie);
    const customerId = customer.customer!.customerId;
    const inserted = await env.DB.prepare("INSERT INTO mail_messages (customer_id, kind, subject, body, created_at) VALUES (?, 'order_placed', '訂單通知', '內容', ?) RETURNING id").bind(customerId, NOW).first<{ id: number }>();
    await env.DB.prepare("INSERT INTO mail_deliveries (message_id, recipient_address, status, attempted_at) VALUES (?, 'old@example.com', 'delivered', ?)").bind(inserted!.id, NOW).run();

    setNow(NOW + 1000);
    await requestVerification(cookie, "new@example.com");
    await app.verifyContactEmail(cookie, { token: await tokenOf(cookie) });
    expect(await app.resendMail(jwt, { messageId: inserted!.id })).toEqual({ ok: true, data: { delivered: true } });

    const mail = await app.getMyMail(cookie, { messageId: inserted!.id });
    expect(mail).toMatchObject({ ok: true, data: { deliveries: [{ recipientAddress: "old@example.com" }, { recipientAddress: "new@example.com" }] } });
  });

  it("顧客沒有已驗證的地址時，非驗證信不能重送", async () => {
    const jwt = await mintAccessJwt();
    const cookie = await signInCustomer("alice", "Alice", { verifiedContact: false });
    const customerId = (await app.getCustomerSession(cookie)).customer!.customerId;
    const inserted = await env.DB.prepare("INSERT INTO mail_messages (customer_id, kind, subject, body, created_at) VALUES (?, 'order_placed', '訂單通知', '內容', ?) RETURNING id").bind(customerId, NOW).first<{ id: number }>();

    expect(await app.resendMail(jwt, { messageId: inserted!.id })).toEqual({ ok: false, reason: "no_verified_contact" });
  });
});

async function tokenOf(cookie: string): Promise<string> {
  const list = await app.listMyMail(cookie);
  if (!list.ok) throw new Error("讀信失敗");
  for (const item of list.data) {
    const mail = await app.getMyMail(cookie, { messageId: item.id });
    if (mail.ok && mail.data.verification?.status === "pending") return mail.data.verification.token;
  }
  throw new Error("沒有可用的驗證連結");
}
