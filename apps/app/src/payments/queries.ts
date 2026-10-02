import { and, asc, eq, isNull, sql, type SQL } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { batchAtEffectiveNow, effectiveNow } from "../shared/high-water-mark";
import { PAYMENT_CUTOFF_BEFORE_DEADLINE_MS } from "../orders/payment-deadline";
import { clock } from "../shared/schema";
import { orders, type OrderStatus } from "../orders/schema";
import { everyLineReclaimableSql, lateSuccessStatusSql, payableStatusSql } from "./payable";
import { paymentNeedsAttentionSql } from "./attention";
import { insertPaymentResultNotice } from "../contact/notices";
import { paymentReconcileIssues, payments, type PaymentStatus, type RefundReason } from "./schema";
import type { PaymentEvent } from "./shared";

export interface OrderForPayment {
  id: number;
  status: OrderStatus;
  totalTwd: number;
  paymentDeadline: number;
}

/** 顧客自己的訂單（付款判定用的欄位）；別人的與不存在的一樣回 undefined。 */
export async function selectOrderForPayment(db: DrizzleD1Database, customerId: string, orderId: number): Promise<OrderForPayment | undefined> {
  const [row] = await db
    .select({ id: orders.id, status: orders.status, totalTwd: orders.totalTwd, paymentDeadline: orders.paymentDeadline })
    .from(orders)
    .where(and(eq(orders.id, orderId), eq(orders.customerId, customerId)));
  return row;
}

export async function hasPaymentWithStatus(db: DrizzleD1Database, orderId: number, status: PaymentStatus): Promise<boolean> {
  const [row] = await db
    .select({ id: payments.id })
    .from(payments)
    .where(and(eq(payments.orderId, orderId), eq(payments.status, status)))
    .limit(1);
  return row !== undefined;
}

/** 這張訂單上本地仍是 pending 的付款（依建立順序）。 */
export async function selectPendingPayments(
  db: DrizzleD1Database,
  orderId: number,
): Promise<{ id: number; gatewayPaymentId: string; amountTwd: number }[]> {
  return db
    .select({ id: payments.id, gatewayPaymentId: payments.gatewayPaymentId, amountTwd: payments.amountTwd })
    .from(payments)
    .where(and(eq(payments.orderId, orderId), eq(payments.status, "pending")))
    .orderBy(asc(payments.id));
}

/**
 * 付款轉為 expired，僅限仍是 pending 的付款（已有結果的不會被蓋掉）；回傳這次呼叫是否真的轉換了。
 * 同一個 batch 把它開著的補查待辦記為已解決（付款不再 pending，待辦就沒有要處理的事）。
 */
export async function expirePayment(db: DrizzleD1Database, paymentId: number, now: number): Promise<boolean> {
  const [updated] = await db.batch([
    db.update(payments).set({ status: "expired" }).where(and(eq(payments.id, paymentId), eq(payments.status, "pending"))).returning({ id: payments.id }),
    db
      .update(paymentReconcileIssues)
      .set({ resolvedAt: now })
      .where(and(eq(paymentReconcileIssues.paymentId, paymentId), isNull(paymentReconcileIssues.resolvedAt), sql`EXISTS (SELECT 1 FROM payments WHERE id = ${paymentId} AND status <> 'pending')`)),
  ]);
  return updated.length > 0;
}

/**
 * 記錄一筆付款，單句條件寫入：只有「這是該顧客的訂單、仍是待付款、還沒進入付款期限前 2 分鐘、沒有成功的付款、
 * 也沒有其他 pending 的付款」時才寫入，金額取自訂單本身。「最多一筆 pending」由這句保證：
 * 兩個分頁同時發起付款，D1 逐句執行，後到的那句看得見先到的 pending 而被擋下。付款期限用高水位的有效時間判定（Holdfast ADR 0011，
 * https://github.com/CarlLee1983/Holdfast/blob/main/docs/adr/0011-expiry-clock-source.md），`now` 只用來推進高水位。
 * 呼叫閘道發生在這句之前（要先有閘道付款 ID），所以判定與寫入之間訂單狀態可能變動，成敗以受影響列數為準。
 * 回傳新付款的編號；被條件擋下回 null。
 */
export async function insertPaymentIfPayable(
  d1: D1Database,
  input: { customerId: string; orderId: number; gatewayPaymentId: string; expiresAt: number },
  now: number,
): Promise<number | null> {
  const { customerId, orderId, gatewayPaymentId, expiresAt } = input;
  const [inserted] = await batchAtEffectiveNow(d1, now, [
    sql`
      INSERT INTO payments (order_id, gateway_payment_id, amount_twd, status, created_at, expires_at)
      SELECT o.id, ${gatewayPaymentId}, o.total_twd, 'pending', ${effectiveNow}, ${expiresAt}
      FROM orders o
      WHERE o.id = ${orderId}
        AND o.customer_id = ${customerId}
        AND ${payableStatusSql()}
        AND o.payment_deadline - ${PAYMENT_CUTOFF_BEFORE_DEADLINE_MS} > ${effectiveNow}
        AND NOT EXISTS (SELECT 1 FROM payments other WHERE other.order_id = o.id AND other.status IN ('succeeded', 'pending'))
    `,
  ]);
  return inserted!.meta.changes > 0 ? inserted!.meta.last_row_id : null;
}

/** 高水位時鐘目前的有效時間（只讀，給診斷用）；還沒有任何寫入推進過時為 0。 */
export async function selectHighWaterMark(db: DrizzleD1Database): Promise<number> {
  const [row] = await db.select({ hwm: clock.hwm }).from(clock);
  return row?.hwm ?? 0;
}

export interface PaymentRef {
  id: number;
  orderId: number;
  amountTwd: number;
  status: PaymentStatus;
}

/** 以閘道付款 ID 找付款（付款不會被刪除）；不存在回 undefined。 */
export async function selectPaymentByGatewayId(db: DrizzleD1Database, gatewayPaymentId: string): Promise<PaymentRef | undefined> {
  const [row] = await db
    .select({ id: payments.id, orderId: payments.orderId, amountTwd: payments.amountTwd, status: payments.status })
    .from(payments)
    .where(eq(payments.gatewayPaymentId, gatewayPaymentId));
  return row;
}

/** 付款目前的狀態與所屬訂單的狀態，兩者都是讀取當下的值。 */
export async function selectPaymentAndOrderStatus(
  db: DrizzleD1Database,
  gatewayPaymentId: string,
): Promise<{ paymentStatus: PaymentStatus; orderStatus: OrderStatus } | undefined> {
  const [row] = await db
    .select({ paymentStatus: payments.status, orderStatus: orders.status })
    .from(payments)
    .innerJoin(orders, eq(orders.id, payments.orderId))
    .where(eq(payments.gatewayPaymentId, gatewayPaymentId));
  return row;
}

/**
 * 套用付款結果的單一 batch：全有或全無，webhook 與導回查詢兩條路徑共用。每句都是條件式寫入，成敗看各自的
 * `meta.changes`；D1 逐句、單寫者執行，兩個並行的套用只會一前一後，後到的看見前者的結果。
 *
 * 0. （batchAtEffectiveNow）先推進高水位，`applied_at` 與其他欄位一樣用有效時間。
 * 1. 記錄事件（`event_id` 唯一，`ON CONFLICT DO NOTHING`）：這是冪等的關卡。這次呼叫搶到事件才會有 `claim` 對得上的那一列，
 *    後面每一句都要求 `won`，所以同一個事件重送或同時送達，只有第一次的寫入生效；退款也只由搶到事件的那次觸發。
 * 2. （成功時）訂單轉為已付款，依訂單當下狀態分流，條件都寫在這一句裡（不是先讀後寫）：
 *    - 待付款 → 已付款：付款已成功，待付款保留就地轉為已付款保留；不動在庫數（交運才扣，ADR 0006），保留總量與可售數量不變。
 *    - 已逾期 → 已付款（遲到的付款成功，ADR 0001）：「重新保留」。只有訂單的每一筆明細都滿足可售數量
 *      （`everyLineReclaimableSql`）才轉；一筆不滿足就整張都不轉（全有全無）。可售數量的判定與轉換在同一句，
 *      與並行的結帳搶最後一件時，D1 逐句執行，後到的那句看見先到的結果，不會超賣。
 *    - 已取消、已付款（另一筆付款先成功）、已出貨：不轉，0 列。
 *    同一組條件還要求：搶到事件、這筆付款還在 pending。所以同一張訂單的兩筆付款同時成功時，只有先執行的那一筆轉已付款。
 * 3. 付款轉為事件的結果，僅限仍是 pending 的付款（狀態只往前走，已成功的付款不會被後來的失敗事件蓋掉）。
 * 4. 讀回訂單狀態（`orderStatus`）：就是 batch 當下訂單沒轉成的原因，呼叫端據此決定退款原因。
 *
 * 付款成功但第 2 句沒轉（`orderSettled` 為 false）時，付款仍記為成功、訂單不動（保留也不變）；呼叫端據此決定是否退款（在 batch 之外呼叫閘道）。
 * 保留判定不看付款期限：期限已過但 Cron 還沒轉逾期時，訂單仍是待付款，保留仍在，轉為已付款保留後仍一致。
 */
export async function applyPaymentEvent(
  d1: D1Database,
  event: PaymentEvent & { orderId: number },
  now: number,
): Promise<{ paymentSettled: boolean; orderSettled: boolean; orderStatus: OrderStatus }> {
  const { eventId, gatewayPaymentId, orderId, outcome } = event;
  const claim = crypto.randomUUID();
  const won = sql`EXISTS (SELECT 1 FROM payment_events WHERE event_id = ${eventId} AND claim = ${claim})`;
  const paymentPending = sql`EXISTS (SELECT 1 FROM payments WHERE gateway_payment_id = ${gatewayPaymentId} AND status = 'pending')`;
  const settlesOrder = sql`(${payableStatusSql()} OR (${lateSuccessStatusSql()} AND ${everyLineReclaimableSql(orderId)}))`;

  const statements: SQL[] = [
    sql`
      INSERT INTO payment_events (event_id, gateway_payment_id, outcome, claim, applied_at)
      VALUES (${eventId}, ${gatewayPaymentId}, ${outcome}, ${claim}, ${effectiveNow})
      ON CONFLICT (event_id) DO NOTHING
    `,
  ];
  if (outcome === "succeeded") {
    statements.push(
      sql`
        UPDATE orders SET status = 'paid', paid_by_payment_id = (SELECT id FROM payments WHERE gateway_payment_id = ${gatewayPaymentId})
        WHERE id = ${orderId} AND ${settlesOrder} AND ${won} AND ${paymentPending}
      `,
    );
  }
  statements.push(sql`
    UPDATE payments SET status = ${outcome}
    WHERE gateway_payment_id = ${gatewayPaymentId} AND status = 'pending' AND ${won}
  `);
  // 通知的信件本體與付款結果同一個 batch（outbox）：付款有了結果信就存在，事件重送時事件鍵已有信就不動
  statements.push(insertPaymentResultNotice(gatewayPaymentId));
  // 付款離開 pending（這次或先前的呼叫套用的）：開著的補查待辦記為已解決
  statements.push(sql`
    UPDATE payment_reconcile_issues SET resolved_at = ${effectiveNow}
    WHERE resolved_at IS NULL AND payment_id IN (SELECT id FROM payments WHERE gateway_payment_id = ${gatewayPaymentId} AND status <> 'pending')
  `);
  // 4. 讀回 batch 當下（前面各句之後、同一個交易內）的訂單狀態：退款原因依它決定，不在 batch 之後另讀（之後訂單可能已被別的呼叫轉走）
  statements.push(sql`SELECT status FROM orders WHERE id = ${orderId}`);

  const results = await batchAtEffectiveNow(d1, now, statements);
  const paymentSettled = results[results.length - 4]!.meta.changes > 0;
  const orderSettled = outcome === "succeeded" && results[1]!.meta.changes > 0;
  const orderStatus = (results[results.length - 1]!.results[0] as { status: OrderStatus }).status;
  return { paymentSettled, orderSettled, orderStatus };
}

/**
 * 記下退款的結果，僅限仍是 succeeded 的付款（條件式 UPDATE，狀態只往前走）：成功轉為 refunded、閘道退款失敗轉為 refund_failed，
 * 連同觸發原因與時間（高水位的有效時間，`now` 只用來推進高水位）。回傳這次呼叫是否真的記下了。
 */
export async function recordRefundResult(
  d1: D1Database,
  gatewayPaymentId: string,
  result: { status: "refunded" | "refund_failed"; reason: RefundReason },
  now: number,
): Promise<boolean> {
  const [updated] = await batchAtEffectiveNow(d1, now, [
    sql`
      UPDATE payments SET status = ${result.status}, refund_reason = ${result.reason}, refund_at = ${effectiveNow}
      WHERE gateway_payment_id = ${gatewayPaymentId} AND status = 'succeeded'
    `,
  ]);
  return updated!.meta.changes > 0;
}

export interface PaymentSummary {
  id: number;
  amountTwd: number;
  status: PaymentStatus;
  /** 發起時間，UTC epoch 毫秒。 */
  createdAt: number;
  /** 退款的觸發原因；沒有觸發過退款為 null（退款的結果在 `status`）。 */
  refundReason: RefundReason | null;
  /** 退款結果記下的時間（成功或失敗），UTC epoch 毫秒；沒有觸發過退款為 null。 */
  refundAt: number | null;
  /** 需要處理（見 `attention.ts`）：付款成功卻沒有退款紀錄、而訂單不是由這筆支付，或退款失敗；管理端要顯示「需要處理」。 */
  needsAttention: boolean;
}

/**
 * 顧客自己的付款嘗試摘要，依訂單分組、舊的在前（永遠限定顧客）；`orderId` 再收窄到某一張。不含閘道付款 ID。
 * 本地仍是 pending、但已過閘道失效時間的付款，對外顯示為 expired（閘道端失效不一定有人回報過）。
 */
export async function selectPaymentSummaries(
  db: DrizzleD1Database,
  customerId: string,
  now: number,
  orderId?: number,
): Promise<Map<number, PaymentSummary[]>> {
  return selectSummaries(db, now, and(eq(orders.customerId, customerId), orderId === undefined ? undefined : eq(orders.id, orderId)));
}

/** 管理員讀某張訂單的付款嘗試摘要（不限顧客），形狀與顧客看到的相同。 */
export async function selectOrderPaymentSummaries(db: DrizzleD1Database, now: number, orderId: number): Promise<PaymentSummary[]> {
  return (await selectSummaries(db, now, eq(orders.id, orderId))).get(orderId) ?? [];
}

async function selectSummaries(db: DrizzleD1Database, now: number, where: SQL | undefined): Promise<Map<number, PaymentSummary[]>> {
  const rows = await db
    .select({
      orderId: payments.orderId,
      id: payments.id,
      amountTwd: payments.amountTwd,
      status: payments.status,
      createdAt: payments.createdAt,
      expiresAt: payments.expiresAt,
      refundReason: payments.refundReason,
      refundAt: payments.refundAt,
      needsAttention: sql<number>`CASE WHEN ${paymentNeedsAttentionSql()} THEN 1 ELSE 0 END`,
    })
    .from(payments)
    .innerJoin(orders, eq(orders.id, payments.orderId))
    .where(where)
    .orderBy(asc(payments.id));

  const byOrder = new Map<number, PaymentSummary[]>();
  for (const { orderId: owner, expiresAt, status, needsAttention, ...summary } of rows) {
    const displayed: PaymentStatus = status === "pending" && now >= expiresAt ? "expired" : status;
    byOrder.set(owner, [...(byOrder.get(owner) ?? []), { ...summary, status: displayed, needsAttention: needsAttention === 1 }]);
  }
  return byOrder;
}
