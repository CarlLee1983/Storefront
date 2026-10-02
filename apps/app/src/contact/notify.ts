import { and, eq, notExists, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { deliveryOutcome, type MailKind } from "./mail";
import { selectVerifiedEmail } from "./queries";
import { mailDeliveries, mailMessages } from "./schema";

export interface TransactionNotice {
  customerId: string;
  kind: MailKind;
  /** 業務事件的識別（例如 `order_placed:12`）：同一個業務變化只會有一封信，技術重試與事件重送不產生新信。 */
  eventKey: string;
  subject: string;
  body: string;
}

/**
 * 把交易通知送進顧客的模擬信箱，冪等：事件鍵已有信就不再建立，也不再嘗試投遞（失敗的投遞由管理員重送）。
 * 收件地址是此刻已驗證的聯絡 email，投遞紀錄保留實際地址；顧客還沒有已驗證地址時只建立信件，
 * 留在管理端待處理，等顧客驗證後重送。信件與首次投遞在同一個 batch，不會有「信建了、投遞沒寫」的中間狀態。
 */
export async function sendNotice(db: DrizzleD1Database, notice: TransactionNotice, now: number): Promise<void> {
  const recipient = await selectVerifiedEmail(db, notice.customerId);
  const insertMessage = db
    .insert(mailMessages)
    .values({ customerId: notice.customerId, kind: notice.kind, subject: notice.subject, body: notice.body, eventKey: notice.eventKey, createdAt: now })
    .onConflictDoNothing({ target: mailMessages.eventKey });
  if (!recipient) {
    await insertMessage;
    return;
  }
  await db.batch([
    insertMessage,
    // 只有還沒有任何投遞的信才投遞：重送的事件撞上既有的信時不會再寄
    db.insert(mailDeliveries).select(
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
          eq(mailMessages.eventKey, notice.eventKey),
          notExists(db.select({ one: sql`1` }).from(mailDeliveries).where(eq(mailDeliveries.messageId, mailMessages.id))),
        )),
    ),
  ]);
}

/**
 * 通知不得讓下單或付款失敗：寄信的任何例外只記 log 並吞下（信件在管理端不見或缺投遞時，
 * 事件重送或冪等重試會補上）。
 */
export async function sendNoticeSafely(db: DrizzleD1Database, notice: TransactionNotice, now: number): Promise<void> {
  try {
    await sendNotice(db, notice, now);
  } catch (error) {
    console.error(JSON.stringify({ event: "notice_failed", kind: notice.kind, eventKey: notice.eventKey, error: error instanceof Error ? error.message : String(error) }));
  }
}
