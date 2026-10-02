import { and, asc, eq, inArray, ne, sql, type SQL } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { insertRefundNotice } from "../contact/notices";
import { batchAtEffectiveNow, effectiveNow } from "../shared/high-water-mark";
import { orders } from "../orders/schema";
import { payments, refundAttempts, refunds } from "./schema";
import type { RefundAttemptAction, RefundAttemptOutcome, RefundReason, RefundStatus } from "./shared";

/**
 * 卡在 processing 的退款（程序中斷、沒記下結果）過了這麼久就視為租約過期：不再阻擋同單其他退款，並可由下一次操作先查證再接手。
 * 一次操作最久是一次查證加一次送出（各最多 `GATEWAY_TIMEOUT_MS`），所以遠大於它。
 */
export const REFUND_CLAIM_LEASE_MS = 60_000;

/** 退款與它所屬付款的閘道 ID，執行退款時用。 */
export interface RefundToRun {
  id: number;
  orderId: number;
  paymentId: number;
  gatewayPaymentId: string;
  amountTwd: number;
  status: RefundStatus;
  claimedAt: number | null;
}

/**
 * 登記一筆付款層級原因（遲到、已取消、重複，見 `refundReasonFor`）的整筆退款，單句條件寫入：付款必須是 succeeded、
 * 不是讓訂單成立的那一筆、這筆付款還沒有任何退款（額度還在）才寫入，金額取自付款本身，拆成商品款與原運費（取自訂單的運費快照）。
 * 重送或事件補寫撞到唯一索引時不重複登記，回既有那筆。回傳退款編號；付款不是 succeeded 或額度已被占用回 null。
 */
export async function registerPaymentRefund(d1: D1Database, paymentId: number, reason: RefundReason, now: number): Promise<number | null> {
  const [inserted] = await batchAtEffectiveNow(d1, now, [
    sql`
      INSERT INTO refunds (order_id, payment_id, reason, amount_twd, goods_twd, shipping_twd, status, created_at)
      SELECT p.order_id, p.id, ${reason}, p.amount_twd,
        p.amount_twd - MIN(o.standard_shipping_fee_twd + o.large_shipping_fee_twd, p.amount_twd),
        MIN(o.standard_shipping_fee_twd + o.large_shipping_fee_twd, p.amount_twd),
        'pending', ${effectiveNow}
      FROM payments p JOIN orders o ON o.id = p.order_id
      WHERE p.id = ${paymentId} AND p.status = 'succeeded'
        AND o.paid_by_payment_id IS NOT p.id
        AND NOT EXISTS (SELECT 1 FROM refunds r WHERE r.payment_id = p.id)
      ON CONFLICT DO NOTHING
    `,
  ]);
  if (inserted!.meta.changes > 0) return inserted!.meta.last_row_id;
  const [existing] = await drizzle(d1).select({ id: refunds.id }).from(refunds).where(and(eq(refunds.paymentId, paymentId), eq(refunds.reason, reason)));
  return existing?.id ?? null;
}

export async function selectRefundToRun(db: DrizzleD1Database, refundId: number): Promise<RefundToRun | undefined> {
  const [row] = await db
    .select({
      id: refunds.id,
      orderId: refunds.orderId,
      paymentId: refunds.paymentId,
      gatewayPaymentId: payments.gatewayPaymentId,
      amountTwd: refunds.amountTwd,
      status: refunds.status,
      claimedAt: refunds.claimedAt,
    })
    .from(refunds)
    .innerJoin(payments, eq(payments.id, refunds.paymentId))
    .where(eq(refunds.id, refundId));
  return row;
}

/** 這筆退款能不能由「現在讀到的狀態」直接送出：還沒送出或明確失敗的送出；結果不明或租約過期的 processing 要先查證。 */
export function actionFor(refund: Pick<RefundToRun, "status" | "claimedAt">, now: number): "send" | "verify" | "busy" | "done" {
  switch (refund.status) {
    case "pending":
    case "failed":
      return "send";
    case "unknown":
      return "verify";
    case "processing":
      return now - (refund.claimedAt ?? 0) >= REFUND_CLAIM_LEASE_MS ? "verify" : "busy";
    case "succeeded":
      return "done";
  }
}

/** 同張訂單上，這筆之外有沒有「結果不明」或「租約內仍在送出」的退款：有就不能開始這一筆（ADR 0007：不明阻擋後筆、同單不並行）。 */
function otherUncertainSql(orderIdSql: SQL, selfIdSql: SQL, now: number) {
  return sql`EXISTS (
    SELECT 1 FROM refunds other WHERE other.order_id = ${orderIdSql} AND other.id <> ${selfIdSql}
      AND (other.status = 'unknown' OR (other.status = 'processing' AND other.claimed_at > ${now - REFUND_CLAIM_LEASE_MS}))
  )`;
}

/**
 * 搶到這筆退款的執行權（單句條件 UPDATE，讀到的狀態必須沒變，且同單沒有其他不明或進行中的退款）：轉為 processing 並記下租約起點。
 * D1 逐句執行，同一張訂單的兩個並行呼叫只有一個搶得到。回傳是否搶到。
 */
export async function claimRefund(d1: D1Database, refund: RefundToRun, now: number): Promise<boolean> {
  const [claimed] = await batchAtEffectiveNow(d1, now, [
    sql`
      UPDATE refunds SET status = 'processing', claimed_at = ${now}
      WHERE id = ${refund.id} AND status = ${refund.status} AND claimed_at IS ${refund.claimedAt}
        AND NOT ${otherUncertainSql(sql`refunds.order_id`, sql`refunds.id`, now)}
    `,
  ]);
  return claimed!.meta.changes > 0;
}

/** 同張訂單上有沒有其他不明或進行中的退款（搶不到執行權時，用來說明是「等前筆」還是「同時有人在處理」）。 */
export async function hasOtherUncertainRefund(db: DrizzleD1Database, refund: RefundToRun, now: number): Promise<boolean> {
  const [row] = await db
    .select({ one: sql<number>`1` })
    .from(refunds)
    .where(
      and(
        eq(refunds.orderId, refund.orderId),
        ne(refunds.id, refund.id),
        sql`(${refunds.status} = 'unknown' OR (${refunds.status} = 'processing' AND ${refunds.claimedAt} > ${now - REFUND_CLAIM_LEASE_MS}))`,
      ),
    );
  return row !== undefined;
}

export interface RefundAttemptRecord {
  refundId: number;
  /** 這次操作搶到的租約起點（`claimed_at`）；結果只在租約仍是自己的時候寫回狀態。 */
  claimedAt: number;
  actor: string;
  action: RefundAttemptAction;
  outcome: RefundAttemptOutcome;
  code: string | null;
  /** 這次嘗試之後退款的新狀態；null 表示只記嘗試、狀態仍是 processing（例如查證後要接著送出）。 */
  status: Exclude<RefundStatus, "pending" | "processing"> | null;
}

/**
 * 記下一次退款嘗試，同一個 batch 內：嘗試紀錄（一律寫）、退款狀態（僅限租約仍是自己的 processing）、
 * 成功時的退款通知信（outbox，見 `contact/notices.ts`）。回傳狀態是否真的寫回。
 */
export async function recordRefundAttempt(d1: D1Database, record: RefundAttemptRecord, now: number): Promise<boolean> {
  const { refundId, claimedAt, actor, action, outcome, code, status } = record;
  const statements = [
    sql`INSERT INTO refund_attempts (refund_id, at, actor, action, outcome, code) VALUES (${refundId}, ${effectiveNow}, ${actor}, ${action}, ${outcome}, ${code})`,
  ];
  if (status !== null) {
    statements.push(sql`
      UPDATE refunds SET status = ${status}, settled_at = ${status === "succeeded" ? effectiveNow : null}
      WHERE id = ${refundId} AND status = 'processing' AND claimed_at = ${claimedAt}
    `);
    if (status === "succeeded") statements.push(insertRefundNotice(refundId));
  }
  const results = await batchAtEffectiveNow(d1, now, statements);
  return status === null ? true : results[1]!.meta.changes > 0;
}

export interface RefundAttemptView {
  at: number;
  actor: string;
  action: RefundAttemptAction;
  outcome: RefundAttemptOutcome;
  code: string | null;
}

/** 退款的對外檢視（顧客與管理員共用的部分）；不含閘道 ID。 */
export interface RefundSummary {
  id: number;
  paymentId: number;
  reason: RefundReason;
  amountTwd: number;
  goodsTwd: number;
  shippingTwd: number;
  status: RefundStatus;
  /** 登記時間，UTC epoch 毫秒。 */
  createdAt: number;
  /** 款項確認退回的時間；尚未成功為 null。 */
  settledAt: number | null;
}

export interface AdminRefund extends RefundSummary {
  orderId: number;
  attempts: RefundAttemptView[];
}

const summaryColumns = {
  id: refunds.id,
  paymentId: refunds.paymentId,
  reason: refunds.reason,
  amountTwd: refunds.amountTwd,
  goodsTwd: refunds.goodsTwd,
  shippingTwd: refunds.shippingTwd,
  status: refunds.status,
  createdAt: refunds.createdAt,
  settledAt: refunds.settledAt,
};

/** 顧客自己訂單的退款，依訂單分組、舊的在前（永遠限定顧客）；`orderId` 再收窄到某一張。 */
export async function selectRefundSummaries(db: DrizzleD1Database, customerId: string, orderId?: number): Promise<Map<number, RefundSummary[]>> {
  const rows = await db
    .select({ orderId: refunds.orderId, ...summaryColumns })
    .from(refunds)
    .innerJoin(orders, eq(orders.id, refunds.orderId))
    .where(and(eq(orders.customerId, customerId), orderId === undefined ? undefined : eq(refunds.orderId, orderId)))
    .orderBy(asc(refunds.id));
  const byOrder = new Map<number, RefundSummary[]>();
  for (const { orderId: owner, ...summary } of rows) byOrder.set(owner, [...(byOrder.get(owner) ?? []), summary]);
  return byOrder;
}

async function withAttempts(db: DrizzleD1Database, rows: (RefundSummary & { orderId: number })[]): Promise<AdminRefund[]> {
  if (rows.length === 0) return [];
  const attempts = await db
    .select({ refundId: refundAttempts.refundId, at: refundAttempts.at, actor: refundAttempts.actor, action: refundAttempts.action, outcome: refundAttempts.outcome, code: refundAttempts.code })
    .from(refundAttempts)
    .where(inArray(refundAttempts.refundId, rows.map((row) => row.id)))
    .orderBy(asc(refundAttempts.id));
  return rows.map((row) => ({
    ...row,
    attempts: attempts.filter((attempt) => attempt.refundId === row.id).map(({ refundId: _refundId, ...attempt }) => attempt),
  }));
}

/** 管理員讀某張訂單的全部退款（含嘗試紀錄），舊的在前。 */
export async function selectOrderRefunds(db: DrizzleD1Database, orderId: number): Promise<AdminRefund[]> {
  const rows = await db.select({ orderId: refunds.orderId, ...summaryColumns }).from(refunds).where(eq(refunds.orderId, orderId)).orderBy(asc(refunds.id));
  return withAttempts(db, rows);
}

/** 退款待辦清單最多列出幾筆，其餘以 `omitted` 回報筆數。 */
const ADMIN_REFUND_LIMIT = 200;

export interface RefundTodo extends AdminRefund {
  /** 同張訂單上有其他結果不明（或仍在送出）的退款：這一筆要等前筆查證後才能執行。 */
  blocked: boolean;
}

/** 管理員的退款待辦：所有尚未成功的退款（結果不明的在前，其次明確失敗、等待與處理中），同順位舊的在前。 */
export async function selectRefundTodos(db: DrizzleD1Database, now: number): Promise<{ refunds: RefundTodo[]; omitted: number }> {
  const open = ne(refunds.status, "succeeded");
  const rows = await db
    .select({
      orderId: refunds.orderId,
      ...summaryColumns,
      blocked: sql<number>`CASE WHEN ${otherUncertainSql(sql`refunds.order_id`, sql`refunds.id`, now)} THEN 1 ELSE 0 END`,
    })
    .from(refunds)
    .where(open)
    .orderBy(sql`CASE ${refunds.status} WHEN 'unknown' THEN 0 WHEN 'failed' THEN 1 ELSE 2 END`, asc(refunds.id))
    .limit(ADMIN_REFUND_LIMIT);
  const [{ total } = { total: 0 }] = await db.select({ total: sql<number>`count(*)` }).from(refunds).where(open);
  const withLog = await withAttempts(db, rows.map(({ blocked: _blocked, ...row }) => row));
  return {
    omitted: Math.max(0, total - rows.length),
    refunds: withLog.map((refund, index) => ({ ...refund, blocked: rows[index]!.blocked === 1 })),
  };
}

/**
 * 這筆付款還能退多少：付款實收減去所有退款（含尚未成功的，它們仍占額度，ADR 0007）。
 * 部分取消與發票折讓（#116、#121、#122）承諾新退款前以它確認額度。
 */
export async function selectRefundableTwd(db: DrizzleD1Database, paymentId: number): Promise<number | undefined> {
  const [row] = await db
    .select({
      // 欄位一律寫全名：drizzle 在單表查詢裡會省略表名，子查詢內會被解析成 refunds 自己的欄位
      refundable: sql<number>`payments.amount_twd - COALESCE((SELECT SUM(r.amount_twd) FROM refunds r WHERE r.payment_id = payments.id), 0)`,
    })
    .from(payments)
    .where(and(eq(payments.id, paymentId), eq(payments.status, "succeeded")));
  return row?.refundable;
}

