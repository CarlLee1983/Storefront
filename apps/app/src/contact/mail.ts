import { sql, type SQL } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { mailDeliveries } from "./schema";

/** 信件種類；新增通知種類在這裡加一個值（資料表不限制 kind）。 */
export const MAIL_KINDS = ["contact_verification", "order_placed", "payment_succeeded", "payment_failed", "payment_unsettled", "shipment_dispatched"] as const;
export type MailKind = (typeof MAIL_KINDS)[number];

/** 驗證請求的有效期限。 */
export const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

/** 這次投遞的結果由演練控制決定：開了「投遞失敗」就失敗，否則送達。與寫入同一句，不會讀到過期的開關。 */
export const deliveryOutcome = sql<"delivered" | "failed">`CASE WHEN COALESCE((SELECT fail_deliveries FROM mail_controls WHERE id = 1), 0) = 1 THEN 'failed' ELSE 'delivered' END`;

/**
 * 一次投遞嘗試的寫入語句（新信或重送都用它；`handledBy` 是手動重送的管理員）；`messageId` 可以是剛插入那封信的 `last_insert_rowid()`。
 * 回傳 `returning` 的投遞編號與結果，呼叫端放進 batch。
 */
export function insertDelivery(db: DrizzleD1Database, messageId: number | SQL, recipientAddress: string, now: number, handledBy: string | null = null) {
  return db
    .insert(mailDeliveries)
    .values({ messageId, recipientAddress, status: deliveryOutcome, attemptedAt: now, handledBy })
    .returning({ id: mailDeliveries.id, status: mailDeliveries.status });
}

/** 頻率限制：同一顧客在這段時間內最多建立這麼多筆驗證請求，擋住重複觸發寄信。 */
export const VERIFICATION_RATE_WINDOW_MS = 10 * 60 * 1000;
export const VERIFICATION_RATE_LIMIT = 5;
