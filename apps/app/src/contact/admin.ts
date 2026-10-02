import { desc, eq, or, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { user } from "../auth/schema";
import type { Clock } from "../shared/clock";
import { fail, ok } from "../shared/result";
import { insertDelivery } from "./mail";
import { describeVerification, selectVerifiedEmail } from "./queries";
import { contactVerifications, mailControls, mailDeliveries, mailMessages } from "./schema";

/** 管理端清單只看最新這麼多封信。 */
const ADMIN_MAIL_LIMIT = 200;

/**
 * 管理員看的投遞結果：每封信的種類、顧客、每次投遞的實際收件地址、結果與處理人。
 * 刻意不選信件內文與驗證憑證：驗證連結不公開，管理員只能看結果與操作演練控制。
 * `needsAttention` 是待辦：還沒有任何一次送達、而且還能處理的信（已被取代或過期的驗證信重送不了，不算待辦）。
 * 超過最新 200 封的舊信只要還是待辦就仍會列出，不會因為被新信擠出清單而沒人處理。
 */
export async function selectMailForAdmin(db: DrizzleD1Database, now: number) {
  const needsAttention = sql<number>`(
    NOT EXISTS (SELECT 1 FROM mail_deliveries d WHERE d.message_id = ${mailMessages.id} AND d.status = 'delivered')
    AND (${mailMessages.verificationId} IS NULL OR EXISTS (
      SELECT 1 FROM contact_verifications v
      WHERE v.id = ${mailMessages.verificationId} AND v.verified_at IS NULL AND v.superseded_at IS NULL AND v.expires_at > ${now}
    ))
  )`;
  const withinLatest = sql`${mailMessages.id} >= COALESCE((SELECT min(id) FROM (SELECT id FROM mail_messages ORDER BY id DESC LIMIT ${ADMIN_MAIL_LIMIT})), 0)`;
  const [control] = await db.select({ failDeliveries: mailControls.failDeliveries }).from(mailControls).where(eq(mailControls.id, 1));
  const visible = or(withinLatest, sql`${needsAttention} = 1`);
  const messages = await db
    .select({
      id: mailMessages.id,
      kind: mailMessages.kind,
      subject: mailMessages.subject,
      customerId: mailMessages.customerId,
      customerName: user.name,
      createdAt: mailMessages.createdAt,
      needsAttention,
    })
    .from(mailMessages)
    .innerJoin(user, eq(user.id, mailMessages.customerId))
    .where(visible)
    .orderBy(desc(mailMessages.id));
  // 以同一個條件接投遞，不把信件編號逐一帶進 IN（D1 單句的參數有上限）
  const deliveries = await db
    .select({
      id: mailDeliveries.id,
      messageId: mailDeliveries.messageId,
      recipientAddress: mailDeliveries.recipientAddress,
      status: mailDeliveries.status,
      attemptedAt: mailDeliveries.attemptedAt,
      handledBy: mailDeliveries.handledBy,
    })
    .from(mailDeliveries)
    .innerJoin(mailMessages, eq(mailMessages.id, mailDeliveries.messageId))
    .where(visible)
    .orderBy(mailDeliveries.id);
  return {
    failDeliveries: control?.failDeliveries === 1,
    messages: messages.map((message) => ({
      ...message,
      needsAttention: message.needsAttention === 1,
      deliveries: deliveries
        .filter((delivery) => delivery.messageId === message.id)
        .map(({ messageId: _messageId, ...delivery }) => delivery),
    })),
  };
}

/** 開關「之後的投遞一律失敗」的演練控制。 */
export async function setDeliveryFailure(db: DrizzleD1Database, clock: Clock, actor: string, enabled: boolean) {
  const failDeliveries = enabled ? 1 : 0;
  const updatedAt = clock.now();
  await db
    .insert(mailControls)
    .values({ id: 1, failDeliveries, updatedAt })
    .onConflictDoUpdate({ target: mailControls.id, set: { failDeliveries, updatedAt } });
  console.log(JSON.stringify({ event: "mail_delivery_failure_set", actor, enabled }));
  return ok({ enabled });
}

/**
 * 重送一封信：同一封信的新投遞，不是新的顧客事件，不改寫信件與既有投遞紀錄。
 * 驗證信寄到它要驗證的地址，而且該請求必須還能用；其他信寄到顧客目前已驗證的地址（沒有就拒絕）。
 */
export async function resendMessage(db: DrizzleD1Database, clock: Clock, actor: string, messageId: number) {
  const [message] = await db
    .select({ customerId: mailMessages.customerId, verificationId: mailMessages.verificationId })
    .from(mailMessages)
    .where(eq(mailMessages.id, messageId));
  if (!message) return fail("message_not_found");

  const now = clock.now();
  let recipient: string | null;
  if (message.verificationId !== null) {
    const [verification] = await db.select().from(contactVerifications).where(eq(contactVerifications.id, message.verificationId));
    if (!verification || describeVerification(verification, now).status !== "pending") return fail("message_not_resendable");
    recipient = verification.email;
  } else {
    recipient = await selectVerifiedEmail(db, message.customerId);
    if (!recipient) return fail("no_verified_contact");
  }

  const [delivery] = await insertDelivery(db, messageId, recipient, now, actor);
  const delivered = delivery!.status === "delivered";
  console.log(JSON.stringify({ event: "mail_resent", actor, messageId, delivered }));
  return ok({ delivered });
}
