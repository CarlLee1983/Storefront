import { eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { resendMessage } from "../contact/admin";
import { mailMessages } from "../contact/schema";
import type { Clock } from "../shared/clock";
import { fail } from "../shared/result";
import { allowanceObligations, invoices } from "./schema";

/**
 * 重寄一張已開立發票的憑證信：同一封信的新投遞，寄到顧客「目前」已驗證的聯絡 email（沒有已驗證地址回 `no_verified_contact`），
 * 不改寫歷史投遞紀錄，也不改寫信件內容與發票（開立當時的原額）。發票尚未開立（沒有憑證）回 `invoice_not_issued`，不存在回 `invoice_not_found`。
 */
export async function resendInvoiceCertificate(db: DrizzleD1Database, clock: Clock, actor: string, invoiceId: number) {
  const [invoice] = await db.select({ status: invoices.status }).from(invoices).where(eq(invoices.id, invoiceId));
  if (!invoice) return fail("invoice_not_found");
  if (invoice.status !== "issued") return fail("invoice_not_issued");
  const [message] = await db.select({ id: mailMessages.id }).from(mailMessages).where(eq(mailMessages.eventKey, `invoice:${invoiceId}`));
  // 開立與信件同一個 batch，已開立就一定有信；找不到代表資料被改過，不憑空補一封
  if (!message) return fail("invoice_not_issued");
  return resendMessage(db, clock, actor, message.id);
}

/**
 * 重寄一筆已折讓的折讓通知：同一封信的新投遞，寄到顧客「目前」已驗證的聯絡 email（沒有已驗證地址回 `no_verified_contact`），
 * 不改寫歷史投遞紀錄與信件內容。尚未折讓回 `allowance_not_issued`，不存在回 `allowance_not_found`。
 */
export async function resendAllowanceNotice(db: DrizzleD1Database, clock: Clock, actor: string, refundId: number) {
  const [allowance] = await db.select({ status: allowanceObligations.status }).from(allowanceObligations).where(eq(allowanceObligations.refundId, refundId));
  if (!allowance) return fail("allowance_not_found");
  if (allowance.status !== "issued") return fail("allowance_not_issued");
  const [message] = await db.select({ id: mailMessages.id }).from(mailMessages).where(eq(mailMessages.eventKey, `allowance:${refundId}`));
  // 折讓與信件同一個 batch，已折讓就一定有信；找不到代表資料被改過，不憑空補一封
  if (!message) return fail("allowance_not_issued");
  return resendMessage(db, clock, actor, message.id);
}
