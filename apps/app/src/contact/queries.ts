import { and, desc, eq, gt, gte, isNotNull, isNull, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { contactVerifications, mailDeliveries, mailMessages } from "./schema";

type Db = DrizzleD1Database;

/** 顧客目前已驗證的聯絡 email（通知收件地址）：最近一次驗證成功的那一筆；沒有回 null。 */
export async function selectVerifiedEmail(db: Db, customerId: string): Promise<string | null> {
  return (await selectCurrentVerified(db, customerId))?.email ?? null;
}

/** 目前已驗證的那一筆驗證請求（編號與地址）。 */
export async function selectCurrentVerified(db: Db, customerId: string) {
  const [row] = await db
    .select({ id: contactVerifications.id, email: contactVerifications.email })
    .from(contactVerifications)
    .where(and(eq(contactVerifications.customerId, customerId), isNotNull(contactVerifications.verifiedAt)))
    .orderBy(desc(contactVerifications.verifiedAt), desc(contactVerifications.id))
    .limit(1);
  return row ?? null;
}

/** 某時間點之後該顧客建立的驗證請求筆數（頻率限制用）。 */
export async function countVerificationsSince(db: Db, customerId: string, since: number): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(contactVerifications)
    .where(and(eq(contactVerifications.customerId, customerId), gte(contactVerifications.createdAt, since)));
  return row?.count ?? 0;
}

/** 顧客還在等待驗證的請求（未驗證、未被取代、未過期）；請求建立時會取代前一筆，所以至多一筆。 */
export async function selectPendingVerification(db: Db, customerId: string, now: number) {
  const [row] = await db
    .select({ email: contactVerifications.email, expiresAt: contactVerifications.expiresAt })
    .from(contactVerifications)
    .where(and(
      eq(contactVerifications.customerId, customerId),
      isNull(contactVerifications.verifiedAt),
      isNull(contactVerifications.supersededAt),
      gt(contactVerifications.expiresAt, now),
    ))
    .orderBy(desc(contactVerifications.id))
    .limit(1);
  return row ?? null;
}

/** 以憑證找該顧客自己的驗證請求；別人的憑證與不存在一樣回 null。 */
export async function selectVerificationByToken(db: Db, customerId: string, token: string) {
  const [row] = await db
    .select({ id: contactVerifications.id, email: contactVerifications.email, verifiedAt: contactVerifications.verifiedAt })
    .from(contactVerifications)
    .where(and(eq(contactVerifications.customerId, customerId), eq(contactVerifications.token, token)));
  return row ?? null;
}

/** 顧客信箱的信件清單：只含至少一次送達的信，新的在前。 */
export async function selectMailList(db: Db, customerId: string) {
  const rows = await db
    .select({
      id: mailMessages.id,
      kind: mailMessages.kind,
      subject: mailMessages.subject,
      createdAt: mailMessages.createdAt,
      receivedAt: sql<number>`min(${mailDeliveries.attemptedAt})`,
      recipientAddress: sql<string>`(SELECT d.recipient_address FROM mail_deliveries d WHERE d.message_id = ${mailMessages.id} AND d.status = 'delivered' ORDER BY d.id DESC LIMIT 1)`,
    })
    .from(mailMessages)
    .innerJoin(mailDeliveries, and(eq(mailDeliveries.messageId, mailMessages.id), eq(mailDeliveries.status, "delivered")))
    .where(eq(mailMessages.customerId, customerId))
    .groupBy(mailMessages.id)
    .orderBy(desc(mailMessages.id));
  return rows;
}

/** 單封信（含內容與送達紀錄）；不屬於該顧客或從未送達都回 null，不洩漏存在與否。 */
export async function selectMail(db: Db, customerId: string, messageId: number, now: number) {
  const [message] = await db
    .select({
      id: mailMessages.id,
      kind: mailMessages.kind,
      subject: mailMessages.subject,
      body: mailMessages.body,
      createdAt: mailMessages.createdAt,
      verificationId: mailMessages.verificationId,
    })
    .from(mailMessages)
    .where(and(eq(mailMessages.id, messageId), eq(mailMessages.customerId, customerId)));
  if (!message) return null;
  const deliveries = await db
    .select({ recipientAddress: mailDeliveries.recipientAddress, attemptedAt: mailDeliveries.attemptedAt })
    .from(mailDeliveries)
    .where(and(eq(mailDeliveries.messageId, messageId), eq(mailDeliveries.status, "delivered")))
    .orderBy(mailDeliveries.id);
  if (deliveries.length === 0) return null;

  let verification: VerificationView | null = null;
  if (message.verificationId !== null) {
    const [row] = await db
      .select({
        email: contactVerifications.email,
        token: contactVerifications.token,
        expiresAt: contactVerifications.expiresAt,
        verifiedAt: contactVerifications.verifiedAt,
        supersededAt: contactVerifications.supersededAt,
      })
      .from(contactVerifications)
      .where(eq(contactVerifications.id, message.verificationId));
    if (row) verification = describeVerification(row, now);
  }
  const { verificationId: _verificationId, ...visible } = message;
  return { ...visible, deliveries, verification };
}

export type VerificationView =
  | { status: "pending"; email: string; token: string }
  | { status: "verified" | "superseded" | "expired"; email: string };

/** 驗證請求目前的狀態；只有 pending 帶憑證（驗證連結只給還能用的請求）。 */
export function describeVerification(row: { email: string; token: string; expiresAt: number; verifiedAt: number | null; supersededAt: number | null }, now: number): VerificationView {
  if (row.verifiedAt !== null) return { status: "verified", email: row.email };
  if (row.supersededAt !== null) return { status: "superseded", email: row.email };
  if (row.expiresAt <= now) return { status: "expired", email: row.email };
  return { status: "pending", email: row.email, token: row.token };
}
