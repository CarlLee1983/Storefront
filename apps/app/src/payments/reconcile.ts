import { and, asc, eq, isNull, lte, or, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { payments, paymentReconcileIssues, type ReconcileIssueReason } from "./schema";

/**
 * 付款建立後這麼久仍是 pending，Cron 才主動補查：留時間給顧客付款與 webhook、導回查詢，不與它們搶著查。
 * 付款已過閘道失效時間（`expires_at`）的不受此限：付款期限前 2 分鐘才發起的付款，失效時間離建立不到寬限時間，
 * 仍要在訂單逾期之前查到結果。
 */
export const RECONCILE_GRACE_MS = 5 * 60_000;
/** 一次 Cron 補查最久花多久（真實時間）；超過就不再開始新的一筆，讓訂單逾期與圖片清理照常進行。 */
export const RECONCILE_BUDGET_MS = 20_000;
/** Cron 每次最多補查幾筆（每筆一次閘道呼叫）；補查失敗的排在後面，不會擋住還沒查過的。 */
export const RECONCILE_BATCH_SIZE = 20;
/** 管理端清單最多列出幾筆待補查的付款，其餘以 `omitted` 回報筆數。 */
const ADMIN_RECONCILE_LIMIT = 200;

export interface PaymentToReconcile {
  id: number;
  orderId: number;
  gatewayPaymentId: string;
  amountTwd: number;
}

/** 以付款編號找仍是 pending 的付款；不存在或已有結果回 undefined。 */
export async function selectPendingPaymentById(db: DrizzleD1Database, paymentId: number): Promise<PaymentToReconcile | undefined> {
  const [row] = await db
    .select({ id: payments.id, orderId: payments.orderId, gatewayPaymentId: payments.gatewayPaymentId, amountTwd: payments.amountTwd })
    .from(payments)
    .where(and(eq(payments.id, paymentId), eq(payments.status, "pending")));
  return row;
}

/** 付款是否存在（不論狀態），區分「找不到」與「已經有結果」。 */
export async function paymentExists(db: DrizzleD1Database, paymentId: number): Promise<boolean> {
  const [row] = await db.select({ id: payments.id }).from(payments).where(eq(payments.id, paymentId));
  return row !== undefined;
}

/**
 * Cron 該補查的付款：本地仍是 pending，而且建立超過寬限時間或已過閘道失效時間（閘道也許在失效前就收款了）。
 * 最久沒補查過的在前（從沒查過的視為 0；不論上次結果，所以一直查不出結果的付款不會把其他付款擠出每次的名額），
 * 其中失效時間較早的先查。
 */
export async function selectDuePayments(db: DrizzleD1Database, now: number): Promise<PaymentToReconcile[]> {
  return db
    .select({ id: payments.id, orderId: payments.orderId, gatewayPaymentId: payments.gatewayPaymentId, amountTwd: payments.amountTwd })
    .from(payments)
    .where(and(eq(payments.status, "pending"), or(lte(payments.createdAt, now - RECONCILE_GRACE_MS), lte(payments.expiresAt, now))))
    .orderBy(sql`coalesce(${payments.reconciledAt}, 0)`, asc(payments.expiresAt), asc(payments.id))
    .limit(RECONCILE_BATCH_SIZE);
}

/** 記下這筆付款剛被補查過（開始查之前就記，閘道卡住或出錯也一樣，Cron 才會輪到別的付款）。 */
export async function markReconciled(db: DrizzleD1Database, paymentId: number, now: number): Promise<void> {
  await db.update(payments).set({ reconciledAt: now }).where(eq(payments.id, paymentId));
}

/**
 * 記下補查沒能確認結果的待辦（每筆付款一列）：已有開著的待辦就累計次數，已解決過的重新開始一輪。
 * 只對仍是 pending 的付款記（條件在這一句裡），付款若在補查期間被別的路徑套用就不留待辦。
 * 待辦是否開著只看 `resolved_at`：付款離開 pending 時由套用的路徑一併記為已解決（`applyPaymentEvent`、`expirePayment`）。
 */
export async function recordReconcileIssue(
  d1: D1Database,
  paymentId: number,
  reason: ReconcileIssueReason,
  source: string,
  now: number,
): Promise<void> {
  await d1
    .prepare(
      `INSERT INTO payment_reconcile_issues (payment_id, reason, attempts, first_at, last_at, last_source, resolved_at)
       SELECT id, ?2, 1, ?3, ?3, ?4, NULL FROM payments WHERE id = ?1 AND status = 'pending'
       ON CONFLICT (payment_id) DO UPDATE SET
         reason = excluded.reason,
         attempts = CASE WHEN resolved_at IS NULL THEN attempts + 1 ELSE 1 END,
         first_at = CASE WHEN resolved_at IS NULL THEN first_at ELSE excluded.first_at END,
         last_at = excluded.last_at,
         last_source = excluded.last_source,
         resolved_at = NULL`,
    )
    .bind(paymentId, reason, now, source)
    .run();
}

/** 開著的待辦記為已解決（補查確認了結果，或付款離開 pending）。 */
export async function resolveReconcileIssue(db: DrizzleD1Database, paymentId: number, now: number): Promise<void> {
  await db
    .update(paymentReconcileIssues)
    .set({ resolvedAt: now })
    .where(and(eq(paymentReconcileIssues.paymentId, paymentId), isNull(paymentReconcileIssues.resolvedAt)));
}

export interface ReconcileListing {
  /** 本地仍是 pending 的付款：有開著待辦的在前，其餘依建立順序。 */
  payments: {
    paymentId: number;
    orderId: number;
    amountTwd: number;
    /** 發起時間，UTC epoch 毫秒。 */
    createdAt: number;
    /** 閘道回報的失效時間，UTC epoch 毫秒。 */
    expiresAt: number;
    /** 開著的待辦（`resolved_at` 為空）；補查沒有失敗過或已解決為 null。 */
    issue: { reason: ReconcileIssueReason; attempts: number; firstAt: number; lastAt: number; lastSource: string } | null;
  }[];
  /** 超過列出上限而沒顯示的付款筆數，不得為負。 */
  omitted: number;
}

/** 管理員看的補查清單（見 `ReconcileListing`）。 */
export async function selectReconcileListing(db: DrizzleD1Database): Promise<ReconcileListing> {
  const rows = await db
    .select({
      paymentId: payments.id,
      orderId: payments.orderId,
      amountTwd: payments.amountTwd,
      createdAt: payments.createdAt,
      expiresAt: payments.expiresAt,
      reason: paymentReconcileIssues.reason,
      attempts: paymentReconcileIssues.attempts,
      firstAt: paymentReconcileIssues.firstAt,
      lastAt: paymentReconcileIssues.lastAt,
      lastSource: paymentReconcileIssues.lastSource,
      resolvedAt: paymentReconcileIssues.resolvedAt,
    })
    .from(payments)
    .leftJoin(paymentReconcileIssues, eq(paymentReconcileIssues.paymentId, payments.id))
    .where(eq(payments.status, "pending"))
    .orderBy(sql`CASE WHEN ${paymentReconcileIssues.paymentId} IS NOT NULL AND ${paymentReconcileIssues.resolvedAt} IS NULL THEN 0 ELSE 1 END`, asc(payments.id))
    .limit(ADMIN_RECONCILE_LIMIT);
  const [{ total } = { total: 0 }] = await db.select({ total: sql<number>`count(*)` }).from(payments).where(eq(payments.status, "pending"));
  return {
    omitted: Math.max(0, total - rows.length),
    payments: rows.map(({ reason, attempts, firstAt, lastAt, lastSource, resolvedAt, ...payment }) => ({
      ...payment,
      issue: reason !== null && attempts !== null && firstAt !== null && lastAt !== null && lastSource !== null && resolvedAt === null
        ? { reason, attempts, firstAt, lastAt, lastSource }
        : null,
    })),
  };
}
