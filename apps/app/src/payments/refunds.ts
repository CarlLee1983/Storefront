import { and, asc, eq, inArray, ne, sql, type SQL } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { insertRefundNotice } from "../contact/notices";
import { batchAtEffectiveNow, effectiveNow } from "../shared/high-water-mark";
import { orders } from "../orders/schema";
import { payments, refundAttempts, refunds } from "./schema";
import type { RefundAttemptAction, RefundAttemptOutcome, RefundReason, RefundStatus } from "./shared";

/**
 * 卡在 processing 的退款（程序中斷、沒記下結果）過了這麼久就視為租約過期，可由下一次操作先查證再接手（它仍阻擋同單其他退款，直到查證結案）。
 * 一次操作最久是一次查證加一次送出（各最多 `GATEWAY_TIMEOUT_MS`），所以遠大於它。
 */
export const REFUND_CLAIM_LEASE_MS = 60_000;

/** 退款與它所屬付款的閘道 ID，執行退款時用。 */
export interface RefundToRun {
  id: number;
  orderId: number;
  paymentId: number;
  gatewayPaymentId: string;
  /** 向閘道送出與查證用的退款 ID（冪等鍵）。 */
  gatewayRefundId: string;
  amountTwd: number;
  status: RefundStatus;
  claimedAt: number | null;
}

/**
 * 承諾一筆退款的額度條件（寫進 INSERT … SELECT 的 WHERE）：付款是 succeeded，且這筆付款所有已登記退款的金額
 * （含 pending、processing、unknown、failed、succeeded——除 succeeded 外都是仍佔用額度的承諾，ADR 0007）加上這一筆不超過實收。
 * `p` 是付款的別名。D1 逐句執行，並行的承諾只有先到的那句看得到空間。
 */
function withinQuotaSql(amount: SQL): SQL {
  return sql`p.status = 'succeeded' AND (SELECT COALESCE(SUM(r.amount_twd), 0) FROM refunds r WHERE r.payment_id = p.id) + ${amount} <= p.amount_twd`;
}

/** 登記後補上閘道退款 ID：同一個 batch 內、INSERT 之後，只補還是空字串的列（只可能是這次寫入的那一列）。 */
const assignGatewayRefundIdSql = sql`UPDATE refunds SET gateway_refund_id = 'rf_' || id WHERE gateway_refund_id = ''`;

export interface RefundCommitment {
  paymentId: number;
  reason: RefundReason;
  amountTwd: number;
  goodsTwd: number;
  shippingTwd: number;
}

/**
 * 承諾（登記）一筆退款：單句條件寫入，額度條件見 `withinQuotaSql`；付款必須屬於同一張訂單的收款，退款綁定該筆付款，不跨收款。
 * 部分取消與發票折讓（#116、#121、#122）要新增退款一律走這裡，不要先讀額度再寫（讀寫之間會超額）。
 * 回傳新退款的編號；額度不足、付款不是 succeeded，或同一付款同一原因已有退款（唯一索引）回 null。
 */
export async function commitRefund(d1: D1Database, commitment: RefundCommitment, now: number): Promise<number | null> {
  const { paymentId, reason, amountTwd, goodsTwd, shippingTwd } = commitment;
  const [inserted] = await batchAtEffectiveNow(d1, now, [
    sql`
      INSERT INTO refunds (order_id, payment_id, reason, amount_twd, goods_twd, shipping_twd, status, created_at)
      SELECT p.order_id, p.id, ${reason}, ${amountTwd}, ${goodsTwd}, ${shippingTwd}, 'pending', ${effectiveNow}
      FROM payments p
      WHERE p.id = ${paymentId} AND ${withinQuotaSql(sql`${amountTwd}`)}
      ON CONFLICT DO NOTHING
    `,
    assignGatewayRefundIdSql,
  ]);
  return inserted!.meta.changes > 0 ? inserted!.meta.last_row_id : null;
}

/**
 * 登記一筆付款層級原因（遲到、已取消、重複，見 `refundReasonFor`）的整筆退款，單句條件寫入：額度條件同 `commitRefund`（整筆金額，
 * 所以這筆付款不能已有其他退款），且付款不是讓訂單成立的那一筆；金額取自付款本身，拆成商品款與原運費（取自訂單的運費快照）。
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
      WHERE p.id = ${paymentId} AND ${withinQuotaSql(sql`p.amount_twd`)}
        AND o.paid_by_payment_id IS NOT p.id
      ON CONFLICT DO NOTHING
    `,
    assignGatewayRefundIdSql,
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
      gatewayRefundId: refunds.gatewayRefundId,
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

/**
 * 同張訂單上，這筆之外有沒有「結果不明」或「進行中」的退款：有就不能開始這一筆（ADR 0007：不明阻擋後筆、同單不並行）。
 * 不看租約：卡住的 processing 也可能其實已送出，所以仍阻擋；租約只決定那一筆本身能不能被接手查證（見 `actionFor`）。
 */
function otherUncertainSql(orderIdSql: SQL, selfIdSql: SQL) {
  return sql`EXISTS (
    SELECT 1 FROM refunds other WHERE other.order_id = ${orderIdSql} AND other.id <> ${selfIdSql} AND other.status IN ('unknown', 'processing')
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
        AND NOT ${otherUncertainSql(sql`refunds.order_id`, sql`refunds.id`)}
    `,
  ]);
  return claimed!.meta.changes > 0;
}

/** 同張訂單上有沒有其他不明或進行中的退款（搶不到執行權時，用來說明是「等前筆」還是「同時有人在處理」）。 */
export async function hasOtherUncertainRefund(db: DrizzleD1Database, refund: RefundToRun): Promise<boolean> {
  const [row] = await db
    .select({ one: sql<number>`1` })
    .from(refunds)
    .where(
      and(
        eq(refunds.orderId, refund.orderId),
        ne(refunds.id, refund.id),
        inArray(refunds.status, ["unknown", "processing"]),
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
export async function selectRefundTodos(db: DrizzleD1Database): Promise<{ refunds: RefundTodo[]; omitted: number }> {
  const open = ne(refunds.status, "succeeded");
  const rows = await db
    .select({
      orderId: refunds.orderId,
      ...summaryColumns,
      blocked: sql<number>`CASE WHEN ${otherUncertainSql(sql`refunds.order_id`, sql`refunds.id`)} THEN 1 ELSE 0 END`,
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
