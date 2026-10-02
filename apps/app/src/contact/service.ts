import { and, eq, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { batchAtEffectiveNow, effectiveNow } from "../shared/high-water-mark";
import type { Clock } from "../shared/clock";
import { parseInput } from "../shared/input";
import { fail, ok, type Unauthorized } from "../shared/result";
import { mailMessageIdInput, requestContactEmailInput, verifyContactEmailInput } from "./input";
import { insertDelivery, VERIFICATION_TTL_MS } from "./mail";
import { selectMail, selectMailList, selectPendingVerification, selectVerificationByToken, selectVerifiedEmail } from "./queries";
import { contactVerifications, mailMessages } from "./schema";

/** 回傳顧客編號；沒有有效 session 回 null。 */
export type AuthenticateCustomer = (cookie: string) => Promise<string | null>;

const VERIFICATION_SUBJECT = "請驗證你的聯絡 email";

/** 驗證信的內文不含驗證連結：連結依請求目前的狀態在顧客讀信時附上，失效的請求不再提供。 */
const verificationBody = (email: string) =>
  `你正在將 ${email} 設為 Still Life 的聯絡 email，訂單通知會寄到這個地址。請在 24 小時內點選信中的驗證連結完成驗證；若不是你本人操作，請忽略這封信。`;

/** 32 位元組的隨機值，base64url。 */
function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * 顧客的聯絡 email 與模擬信箱。所有方法都先由 cookie 換顧客身分，查詢一律以該顧客為條件：
 * 別人的信件、驗證請求與不存在一律得到同樣的結果，不洩漏存在與否。
 */
export function createContactService(d1: D1Database, clock: Clock, authenticate: AuthenticateCustomer) {
  const db = drizzle(d1);
  const unauthorized: Unauthorized = { ok: false, reason: "unauthorized" };

  async function customerOf(cookie: unknown): Promise<string | null> {
    return typeof cookie === "string" ? authenticate(cookie) : null;
  }

  return {
    /** 已驗證的聯絡 email，以及還在等待驗證的新地址（若有）。 */
    async getMyContact(cookie: unknown) {
      const customerId = await customerOf(cookie);
      if (!customerId) return unauthorized;
      const [verifiedEmail, pending] = await Promise.all([
        selectVerifiedEmail(db, customerId),
        selectPendingVerification(db, customerId, clock.now()),
      ]);
      return ok({ verifiedEmail, pending });
    },

    /**
     * 要求驗證一個聯絡 email：取代這位顧客先前未完成的請求、寄出驗證信到模擬信箱（同一個 batch，全有或全無）。
     * 已驗證的地址不受影響，直到新地址驗證成功才換；`delivered` 為 false 表示驗證信投遞失敗（信在管理端，可重送）。
     */
    async requestContactEmail(cookie: unknown, input: unknown) {
      const customerId = await customerOf(cookie);
      if (!customerId) return unauthorized;
      const parsed = parseInput(requestContactEmailInput, input);
      if (!parsed.ok) return parsed;

      const { email } = parsed.data;
      if ((await selectVerifiedEmail(db, customerId)) === email) return fail("already_verified");

      const now = clock.now();
      const [, , [message], [delivery]] = await db.batch([
        db.update(contactVerifications)
          .set({ supersededAt: now })
          .where(and(eq(contactVerifications.customerId, customerId), isNull(contactVerifications.verifiedAt), isNull(contactVerifications.supersededAt))),
        db.insert(contactVerifications).values({ customerId, email, token: newToken(), createdAt: now, expiresAt: now + VERIFICATION_TTL_MS }),
        db.insert(mailMessages)
          .values({ customerId, kind: "contact_verification", subject: VERIFICATION_SUBJECT, body: verificationBody(email), verificationId: sql`last_insert_rowid()`, createdAt: now })
          .returning({ id: mailMessages.id }),
        insertDelivery(db, sql`last_insert_rowid()`, email, now),
      ]);
      const delivered = delivery!.status === "delivered";
      console.log(JSON.stringify({ event: "contact_verification_requested", messageId: message!.id, delivered }));
      return ok({ messageId: message!.id, delivered });
    },

    /**
     * 以信中的憑證完成驗證。憑證必須屬於目前登入的顧客（別人的憑證與不存在同為 `invalid_token`）；
     * 重複點同一個連結是冪等的；被取代或過期的請求回 `verification_closed`。
     */
    async verifyContactEmail(cookie: unknown, input: unknown) {
      const customerId = await customerOf(cookie);
      if (!customerId) return unauthorized;
      const parsed = parseInput(verifyContactEmailInput, input);
      if (!parsed.ok) return parsed;

      const { token } = parsed.data;
      const found = await selectVerificationByToken(db, customerId, token);
      if (!found) return fail("invalid_token");
      if (found.verifiedAt !== null) return ok({ email: found.email });

      // 期限以高水位時間判斷，與其他條件讀時間的寫入一致（Holdfast ADR 0011）
      const [result] = await batchAtEffectiveNow(d1, clock.now(), [
        db.update(contactVerifications)
          .set({ verifiedAt: effectiveNow })
          .where(and(
            eq(contactVerifications.id, found.id),
            isNull(contactVerifications.verifiedAt),
            isNull(contactVerifications.supersededAt),
            sql`${contactVerifications.expiresAt} > ${effectiveNow}`,
          )),
      ]);
      if (result!.meta.changes === 1) {
        console.log(JSON.stringify({ event: "contact_email_verified", verificationId: found.id }));
        return ok({ email: found.email });
      }
      // 沒更新到：可能剛好被並行的同一個連結驗證了，重讀一次才能分辨
      const reread = await selectVerificationByToken(db, customerId, token);
      return reread?.verifiedAt !== null && reread ? ok({ email: reread.email }) : fail("verification_closed");
    },

    async listMyMail(cookie: unknown) {
      const customerId = await customerOf(cookie);
      if (!customerId) return unauthorized;
      return ok(await selectMailList(db, customerId));
    },

    async getMyMail(cookie: unknown, input: unknown) {
      const customerId = await customerOf(cookie);
      if (!customerId) return unauthorized;
      const parsed = parseInput(mailMessageIdInput, input);
      if (!parsed.ok) return parsed;
      const mail = await selectMail(db, customerId, parsed.data.messageId, clock.now());
      return mail ? ok(mail) : fail("mail_not_found");
    },
  };
}

