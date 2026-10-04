import { and, eq, notExists, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { deliveryOutcome } from "./mail";
import { selectVerifiedEmail } from "./queries";
import { mailDeliveries, mailMessages } from "./schema";

/**
 * 投遞一封交易通知的首次投遞（信件本體已由業務交易寫入，見 `notices.ts`），冪等：
 * 信已有任何投遞就不再嘗試（失敗的投遞由管理員重送）。收件地址是此刻已驗證的聯絡 email，投遞紀錄保留實際地址；
 * 顧客沒有已驗證地址時不投遞，信留在管理端待處理，等顧客驗證後重送。
 * 業務事件重送時會再呼叫，補上先前投遞階段出錯而缺的首次投遞。
 */
export async function deliverNotice(db: DrizzleD1Database, eventKey: string, now: number): Promise<void> {
  const [message] = await db.select({ customerId: mailMessages.customerId }).from(mailMessages).where(eq(mailMessages.eventKey, eventKey));
  if (!message) return;
  const recipient = await selectVerifiedEmail(db, message.customerId);
  if (!recipient) return;
  await db.insert(mailDeliveries).select(
    db
      .select({
        id: sql<number | null>`NULL`.as("id"),
        messageId: mailMessages.id,
        recipientAddress: sql<string>`${recipient}`.as("recipient_address"),
        status: deliveryOutcome.as("status"),
        attemptedAt: sql<number>`${now}`.as("attempted_at"),
        handledBy: sql<string | null>`NULL`.as("handled_by"),
      })
      .from(mailMessages)
      .where(and(
        eq(mailMessages.eventKey, eventKey),
        notExists(db.select({ one: sql`1` }).from(mailDeliveries).where(eq(mailDeliveries.messageId, mailMessages.id))),
      )),
  );
}

/**
 * 投遞不得讓下單或付款失敗：任何例外只記 log 並吞下。信件本體已在業務交易內寫好，
 * 缺投遞的信會出現在管理端待處理，也會在同一業務事件重送時補上。
 */
export async function deliverNoticeSafely(db: DrizzleD1Database, eventKey: string, now: number): Promise<void> {
  try {
    await deliverNotice(db, eventKey, now);
  } catch (error) {
    console.error(JSON.stringify({ event: "notice_delivery_failed", eventKey, error: error instanceof Error ? error.message : String(error) }));
  }
}
