import { and, asc, eq, ne, sql, type SQL } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { insertAllowanceNotice } from "../contact/notices";
import { batchAtEffectiveNow, effectiveNow } from "../shared/high-water-mark";
import { allowanceObligations } from "./schema";
import type { AllowanceStatus, InvoiceAttemptAction, InvoiceAttemptOutcome, InvoiceStatus } from "./shared";

/** 折讓時要用的資料：義務、它所屬的原票與訂單參照。 */
export interface AllowanceToRun {
  id: number;
  refundId: number;
  orderId: number;
  paymentId: number;
  gatewayAllowanceKey: string;
  amountTwd: number;
  status: AllowanceStatus;
  /** 原票（同一筆收款的發票）的冪等鍵與狀態；沒有發票（不應發生）為 null。 */
  invoiceKey: string | null;
  invoiceStatus: InvoiceStatus | null;
}

const columns = {
  id: allowanceObligations.id,
  refundId: allowanceObligations.refundId,
  orderId: allowanceObligations.orderId,
  paymentId: allowanceObligations.paymentId,
  gatewayAllowanceKey: allowanceObligations.gatewayAllowanceKey,
  amountTwd: allowanceObligations.amountTwd,
  status: allowanceObligations.status,
  invoiceKey: sql<string | null>`(SELECT i.gateway_invoice_key FROM invoices i WHERE i.payment_id = allowance_obligations.payment_id)`,
  invoiceStatus: sql<InvoiceStatus | null>`(SELECT i.status FROM invoices i WHERE i.payment_id = allowance_obligations.payment_id)`,
};

export async function selectAllowanceToRun(db: DrizzleD1Database, refundId: number): Promise<AllowanceToRun | undefined> {
  const [row] = await db.select(columns).from(allowanceObligations).where(eq(allowanceObligations.refundId, refundId));
  return row;
}

/** 這筆收款上還沒折讓的義務（結果不明的也算：由查證接手），舊的在前。 */
export async function selectOpenAllowancesOfPayment(db: DrizzleD1Database, paymentId: number): Promise<{ refundId: number }[]> {
  return db
    .select({ refundId: allowanceObligations.refundId })
    .from(allowanceObligations)
    .where(and(eq(allowanceObligations.paymentId, paymentId), ne(allowanceObligations.status, "issued")))
    .orderBy(asc(allowanceObligations.id));
}

export interface AllowanceAttemptRecord {
  allowanceId: number;
  refundId: number;
  actor: string;
  action: InvoiceAttemptAction;
  outcome: InvoiceAttemptOutcome;
  code: string | null;
  /** 這次嘗試之後折讓的新狀態；null 表示只記嘗試、狀態不變（查證後要接著送出）。 */
  status: Exclude<AllowanceStatus, "pending"> | null;
  /** 折讓成功時發票服務給的號碼。 */
  allowanceNumber?: string;
}

/**
 * 記下一次折讓嘗試，同一個 batch 內：嘗試紀錄（一律寫）、折讓狀態（已折讓的不會被蓋回去）、
 * 折讓成功時的折讓通知信（outbox，見 `contact/notices.ts`）。回傳這次是否真的把義務轉為已折讓。
 */
export async function recordAllowanceAttempt(d1: D1Database, record: AllowanceAttemptRecord, now: number): Promise<boolean> {
  const { allowanceId, refundId, actor, action, outcome, code, status, allowanceNumber } = record;
  const statements: SQL[] = [
    sql`INSERT INTO allowance_attempts (allowance_id, at, actor, action, outcome, code) VALUES (${allowanceId}, ${effectiveNow}, ${actor}, ${action}, ${outcome}, ${code})`,
  ];
  if (status === "issued") {
    statements.push(
      sql`UPDATE allowance_obligations SET status = 'issued', allowance_number = ${allowanceNumber ?? null}, issued_at = ${effectiveNow} WHERE id = ${allowanceId} AND status <> 'issued'`,
      insertAllowanceNotice(refundId),
    );
  } else if (status !== null) {
    statements.push(sql`UPDATE allowance_obligations SET status = ${status} WHERE id = ${allowanceId} AND status <> 'issued'`);
  }
  const results = await batchAtEffectiveNow(d1, now, statements);
  return status === "issued" && results[1]!.meta.changes > 0;
}
