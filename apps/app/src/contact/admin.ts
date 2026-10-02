import { desc, eq, inArray } from "drizzle-orm";
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
 * 管理員看的投遞結果：每封信的種類、顧客、每次投遞的實際收件地址與結果。
 * 刻意不選信件內文與驗證憑證：驗證連結不公開，管理員只能看結果與操作演練控制。
 */
export async function selectMailForAdmin(db: DrizzleD1Database) {
  const [control] = await db.select({ failDeliveries: mailControls.failDeliveries }).from(mailControls).where(eq(mailControls.id, 1));
  const messages = await db
    .select({
      id: mailMessages.id,
      kind: mailMessages.kind,
      subject: mailMessages.subject,
      customerId: mailMessages.customerId,
      customerName: user.name,
      createdAt: mailMessages.createdAt,
    })
    .from(mailMessages)
    .innerJoin(user, eq(user.id, mailMessages.customerId))
    .orderBy(desc(mailMessages.id))
    .limit(ADMIN_MAIL_LIMIT);
  const deliveries = messages.length === 0 ? [] : await db
    .select({
      id: mailDeliveries.id,
      messageId: mailDeliveries.messageId,
      recipientAddress: mailDeliveries.recipientAddress,
      status: mailDeliveries.status,
      attemptedAt: mailDeliveries.attemptedAt,
    })
    .from(mailDeliveries)
    .where(inArray(mailDeliveries.messageId, messages.map((message) => message.id)))
    .orderBy(mailDeliveries.id);
  return {
    failDeliveries: control?.failDeliveries === 1,
    messages: messages.map((message) => ({
      ...message,
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

  const [delivery] = await insertDelivery(db, messageId, recipient, now);
  const delivered = delivery!.status === "delivered";
  console.log(JSON.stringify({ event: "mail_resent", actor, messageId, delivered }));
  return ok({ delivered });
}
