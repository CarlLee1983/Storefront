import { and, asc, eq, inArray, ne, sql, type SQL } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { insertInvoiceNotice } from "../contact/notices";
import { batchAtEffectiveNow, effectiveNow } from "../shared/high-water-mark";
import { orders } from "../orders/schema";
import { allowanceAttempts, allowanceObligations, invoiceAttempts, invoices } from "./schema";
import type { AllowanceStatus, InvoiceAttemptAction, InvoiceAttemptOutcome, InvoiceStatus } from "./shared";

/**
 * 登記一筆成功收款的開立義務（寫進「套用付款結果」的 batch，見 `payments/queries.ts` 的 `applyPaymentEvent`）：
 * 付款已是 succeeded 才寫，原額取自付款實收；`payment_id` 唯一，事件重送、補查與先前已登記的都不重複，也不改既有那筆。
 * 發票服務的冪等鍵在這裡由應用程式產生、隨 INSERT 寫入，之後沒有任何程式會改它。
 */
export function insertInvoiceObligation(gatewayPaymentId: string): SQL {
  return sql`
    INSERT INTO invoices (order_id, payment_id, gateway_invoice_key, amount_twd, status, created_at)
    SELECT p.order_id, p.id, ${`inv_${crypto.randomUUID()}`}, p.amount_twd, 'pending', ${effectiveNow}
    FROM payments p
    WHERE p.gateway_payment_id = ${gatewayPaymentId} AND p.status = 'succeeded'
    ON CONFLICT (payment_id) DO NOTHING
  `;
}

/**
 * 登記一筆成功退款的待折讓義務（寫進退款轉為成功的 batch，見 `payments/refunds.ts` 的 `recordRefundAttempt`）：
 * 退款已是 succeeded 才寫；`refund_id` 唯一，重試與重複回呼不重複。義務與發票是否已開立無關（退款可能先於延遲的開票成功）。
 * 發票服務的冪等鍵在這裡由應用程式產生、隨 INSERT 寫入，之後沒有任何程式會改它。
 */
export function insertAllowanceObligation(refundId: number): SQL {
  return sql`
    INSERT INTO allowance_obligations (refund_id, payment_id, order_id, amount_twd, created_at, gateway_allowance_key, status)
    SELECT r.id, r.payment_id, r.order_id, r.amount_twd, ${effectiveNow}, ${`alw_${crypto.randomUUID()}`}, 'pending'
    FROM refunds r
    WHERE r.id = ${refundId} AND r.status = 'succeeded'
    ON CONFLICT (refund_id) DO NOTHING
  `;
}

/** 開立發票時要用的資料：發票與它所屬的訂單參照。 */
export interface InvoiceToRun {
  id: number;
  orderId: number;
  paymentId: number;
  gatewayInvoiceKey: string;
  amountTwd: number;
  status: InvoiceStatus;
}

export async function selectInvoiceToRun(db: DrizzleD1Database, invoiceId: number): Promise<InvoiceToRun | undefined> {
  const [row] = await db
    .select({ id: invoices.id, orderId: invoices.orderId, paymentId: invoices.paymentId, gatewayInvoiceKey: invoices.gatewayInvoiceKey, amountTwd: invoices.amountTwd, status: invoices.status })
    .from(invoices)
    .where(eq(invoices.id, invoiceId));
  return row;
}

export async function selectInvoiceToRunByPayment(db: DrizzleD1Database, paymentId: number): Promise<InvoiceToRun | undefined> {
  const [row] = await db.select({ id: invoices.id }).from(invoices).where(eq(invoices.paymentId, paymentId));
  return row ? selectInvoiceToRun(db, row.id) : undefined;
}

export interface InvoiceAttemptRecord {
  invoiceId: number;
  actor: string;
  action: InvoiceAttemptAction;
  outcome: InvoiceAttemptOutcome;
  code: string | null;
  /** 這次嘗試之後發票的新狀態；null 表示只記嘗試、狀態不變（查證後要接著送出）。 */
  status: Exclude<InvoiceStatus, "pending"> | null;
  /** 開立成功時發票服務給的號碼。 */
  invoiceNumber?: string;
}

/**
 * 記下一次開立嘗試，同一個 batch 內：嘗試紀錄（一律寫）、發票狀態（已開立的不會被蓋回去）、
 * 開立成功時的發票通知信（outbox，見 `contact/notices.ts`）。回傳這次是否真的把發票轉為已開立。
 */
export async function recordInvoiceAttempt(d1: D1Database, record: InvoiceAttemptRecord, now: number): Promise<boolean> {
  const { invoiceId, actor, action, outcome, code, status, invoiceNumber } = record;
  const statements: SQL[] = [
    sql`INSERT INTO invoice_attempts (invoice_id, at, actor, action, outcome, code) VALUES (${invoiceId}, ${effectiveNow}, ${actor}, ${action}, ${outcome}, ${code})`,
  ];
  if (status === "issued") {
    statements.push(
      sql`UPDATE invoices SET status = 'issued', invoice_number = ${invoiceNumber ?? null}, issued_at = ${effectiveNow} WHERE id = ${invoiceId} AND status <> 'issued'`,
      insertInvoiceNotice(invoiceId),
    );
  } else if (status !== null) {
    statements.push(sql`UPDATE invoices SET status = ${status} WHERE id = ${invoiceId} AND status <> 'issued'`);
  }
  const results = await batchAtEffectiveNow(d1, now, statements);
  return status === "issued" && results[1]!.meta.changes > 0;
}

/** 待折讓義務與折讓的對外檢視（管理員用）；不含發票服務的冪等鍵。 */
export interface AllowanceObligationView {
  refundId: number;
  paymentId: number;
  amountTwd: number;
  /** 退款確認成功、義務成立的時間，UTC epoch 毫秒。 */
  createdAt: number;
  status: AllowanceStatus;
  /** 發票服務給的折讓號碼；尚未折讓為 null。 */
  allowanceNumber: string | null;
  /** 折讓成功的時間；尚未折讓為 null。 */
  issuedAt: number | null;
  attempts: InvoiceAttemptView[];
}

/**
 * 發票的對外檢視（顧客與管理員共用的部分）；不含發票服務的冪等鍵。
 * `amountTwd` 永遠是原額；`allowedTwd` 是已折讓（憑證已反映）的退款合計，`pendingAllowanceTwd` 是已成功退款、憑證還沒折讓的合計：
 * 未折讓的退款不從原額扣除，所以只有在沒有待折讓（`pendingAllowanceCount` 為 0）時，原額減 `allowedTwd` 才是憑證上的餘額。
 */
export interface InvoiceSummary {
  id: number;
  paymentId: number;
  status: InvoiceStatus;
  amountTwd: number;
  invoiceNumber: string | null;
  /** 登記開立義務的時間，UTC epoch 毫秒。 */
  createdAt: number;
  /** 開立成功的時間；尚未開立為 null。 */
  issuedAt: number | null;
  allowedTwd: number;
  allowedCount: number;
  pendingAllowanceTwd: number;
  pendingAllowanceCount: number;
}

export interface InvoiceAttemptView {
  at: number;
  actor: string;
  action: InvoiceAttemptAction;
  outcome: InvoiceAttemptOutcome;
  code: string | null;
}

export interface AdminInvoice extends InvoiceSummary {
  orderId: number;
  attempts: InvoiceAttemptView[];
  allowances: AllowanceObligationView[];
}

// 子查詢的外層欄位一律寫成帶表名的 SQL：drizzle 單表查詢會省略表名，不帶表名的 `payment_id` 會被子查詢自己的資料表搶先解析，變成永遠成立的條件
const summaryColumns = {
  id: invoices.id,
  paymentId: invoices.paymentId,
  status: invoices.status,
  amountTwd: invoices.amountTwd,
  invoiceNumber: invoices.invoiceNumber,
  createdAt: invoices.createdAt,
  issuedAt: invoices.issuedAt,
  allowedTwd: sql<number>`COALESCE((SELECT SUM(a.amount_twd) FROM allowance_obligations a WHERE a.payment_id = invoices.payment_id AND a.status = 'issued'), 0)`,
  allowedCount: sql<number>`(SELECT COUNT(*) FROM allowance_obligations a WHERE a.payment_id = invoices.payment_id AND a.status = 'issued')`,
  pendingAllowanceTwd: sql<number>`COALESCE((SELECT SUM(a.amount_twd) FROM allowance_obligations a WHERE a.payment_id = invoices.payment_id AND a.status <> 'issued'), 0)`,
  pendingAllowanceCount: sql<number>`(SELECT COUNT(*) FROM allowance_obligations a WHERE a.payment_id = invoices.payment_id AND a.status <> 'issued')`,
};

/** 顧客自己訂單的發票，依訂單分組、舊的在前（永遠限定顧客）；`orderId` 再收窄到某一張。 */
export async function selectInvoiceSummaries(db: DrizzleD1Database, customerId: string, orderId?: number): Promise<Map<number, InvoiceSummary[]>> {
  const rows = await db
    .select({ orderId: invoices.orderId, ...summaryColumns })
    .from(invoices)
    .innerJoin(orders, eq(orders.id, invoices.orderId))
    .where(and(eq(orders.customerId, customerId), orderId === undefined ? undefined : eq(invoices.orderId, orderId)))
    .orderBy(asc(invoices.id));
  const byOrder = new Map<number, InvoiceSummary[]>();
  for (const { orderId: owner, ...summary } of rows) byOrder.set(owner, [...(byOrder.get(owner) ?? []), summary]);
  return byOrder;
}

/** 這些收款的待折讓義務與折讓（含嘗試紀錄），舊的在前。 */
async function selectAllowanceViews(db: DrizzleD1Database, paymentIds: number[]): Promise<(AllowanceObligationView & { id: number })[]> {
  const rows = await db
    .select({
      id: allowanceObligations.id,
      refundId: allowanceObligations.refundId,
      paymentId: allowanceObligations.paymentId,
      amountTwd: allowanceObligations.amountTwd,
      createdAt: allowanceObligations.createdAt,
      status: allowanceObligations.status,
      allowanceNumber: allowanceObligations.allowanceNumber,
      issuedAt: allowanceObligations.issuedAt,
    })
    .from(allowanceObligations)
    .where(inArray(allowanceObligations.paymentId, paymentIds))
    .orderBy(asc(allowanceObligations.id));
  if (rows.length === 0) return [];
  const attempts = await db
    .select({ allowanceId: allowanceAttempts.allowanceId, at: allowanceAttempts.at, actor: allowanceAttempts.actor, action: allowanceAttempts.action, outcome: allowanceAttempts.outcome, code: allowanceAttempts.code })
    .from(allowanceAttempts)
    .where(inArray(allowanceAttempts.allowanceId, rows.map((row) => row.id)))
    .orderBy(asc(allowanceAttempts.id));
  return rows.map((row) => ({
    ...row,
    attempts: attempts.filter((attempt) => attempt.allowanceId === row.id).map(({ allowanceId: _allowanceId, ...attempt }) => attempt),
  }));
}

async function withDetails(db: DrizzleD1Database, rows: (InvoiceSummary & { orderId: number })[]): Promise<AdminInvoice[]> {
  if (rows.length === 0) return [];
  const attempts = await db
    .select({ invoiceId: invoiceAttempts.invoiceId, at: invoiceAttempts.at, actor: invoiceAttempts.actor, action: invoiceAttempts.action, outcome: invoiceAttempts.outcome, code: invoiceAttempts.code })
    .from(invoiceAttempts)
    .where(inArray(invoiceAttempts.invoiceId, rows.map((row) => row.id)))
    .orderBy(asc(invoiceAttempts.id));
  const allowances = await selectAllowanceViews(db, rows.map((row) => row.paymentId));
  return rows.map((row) => ({
    ...row,
    attempts: attempts.filter((attempt) => attempt.invoiceId === row.id).map(({ invoiceId: _invoiceId, ...attempt }) => attempt),
    allowances: allowances.filter((allowance) => allowance.paymentId === row.paymentId),
  }));
}

/** 管理員讀某張訂單的全部發票（含嘗試紀錄與待折讓義務），舊的在前。 */
export async function selectOrderInvoices(db: DrizzleD1Database, orderId: number): Promise<AdminInvoice[]> {
  const rows = await db.select({ orderId: invoices.orderId, ...summaryColumns }).from(invoices).where(eq(invoices.orderId, orderId)).orderBy(asc(invoices.id));
  return withDetails(db, rows);
}

/** 發票待辦清單最多列出幾筆，其餘以 `omitted` 回報筆數。 */
const ADMIN_INVOICE_LIMIT = 200;

/** 管理員的發票待辦：所有尚未開立的發票（結果不明的在前，其次明確失敗與待開立），同順位舊的在前。 */
export async function selectInvoiceTodos(db: DrizzleD1Database): Promise<{ invoices: AdminInvoice[]; omitted: number }> {
  const open = ne(invoices.status, "issued");
  const rows = await db
    .select({ orderId: invoices.orderId, ...summaryColumns })
    .from(invoices)
    .where(open)
    .orderBy(sql`CASE ${invoices.status} WHEN 'unknown' THEN 0 WHEN 'failed' THEN 1 ELSE 2 END`, asc(invoices.id))
    .limit(ADMIN_INVOICE_LIMIT);
  const [{ total } = { total: 0 }] = await db.select({ total: sql<number>`count(*)` }).from(invoices).where(open);
  return { omitted: Math.max(0, total - rows.length), invoices: await withDetails(db, rows) };
}

export interface PendingAllowanceView extends AllowanceObligationView {
  orderId: number;
  /** 這筆退款所屬收款的發票目前狀態；收款沒有發票（不應發生）為 null。 */
  invoiceStatus: InvoiceStatus | null;
}

/** 憑證待補清單：所有尚未折讓的義務（結果不明的在前，其次明確失敗與待折讓），同順位舊的在前，最多 200 筆。 */
export async function selectPendingAllowances(db: DrizzleD1Database): Promise<{ allowances: PendingAllowanceView[]; omitted: number }> {
  const open = ne(allowanceObligations.status, "issued");
  const rows = await db
    .select({
      id: allowanceObligations.id,
      orderId: allowanceObligations.orderId,
      paymentId: allowanceObligations.paymentId,
      invoiceStatus: sql<InvoiceStatus | null>`(SELECT i.status FROM invoices i WHERE i.payment_id = allowance_obligations.payment_id)`,
    })
    .from(allowanceObligations)
    .where(open)
    .orderBy(sql`CASE ${allowanceObligations.status} WHEN 'unknown' THEN 0 WHEN 'failed' THEN 1 ELSE 2 END`, asc(allowanceObligations.id))
    .limit(ADMIN_INVOICE_LIMIT);
  const [{ total } = { total: 0 }] = await db.select({ total: sql<number>`count(*)` }).from(allowanceObligations).where(open);
  if (rows.length === 0) return { allowances: [], omitted: 0 };
  const views = new Map((await selectAllowanceViews(db, [...new Set(rows.map((row) => row.paymentId))])).map((view) => [view.id, view]));
  const allowances = rows.map(({ id, orderId, invoiceStatus }) => {
    const { id: _id, ...view } = views.get(id)!;
    return { ...view, orderId, invoiceStatus };
  });
  return { allowances, omitted: Math.max(0, total - rows.length) };
}
