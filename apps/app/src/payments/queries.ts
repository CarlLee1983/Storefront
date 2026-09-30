import { and, asc, eq, sql, type SQL } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { batchAtEffectiveNow, effectiveNow } from "../shared/high-water-mark";
import { orders, type OrderStatus } from "../orders/schema";
import { payableStatusSql } from "./payable";
import { payments, type PaymentStatus } from "./schema";
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

/** 付款轉為 expired，僅限仍是 pending 的付款（已有結果的不會被蓋掉）；回傳這次呼叫是否真的轉換了。 */
export async function expirePayment(db: DrizzleD1Database, paymentId: number): Promise<boolean> {
  const updated = await db
    .update(payments)
    .set({ status: "expired" })
    .where(and(eq(payments.id, paymentId), eq(payments.status, "pending")))
    .returning({ id: payments.id });
  return updated.length > 0;
}

/**
 * 記錄一筆付款，單句條件寫入：只有「這是該顧客的訂單、仍是待付款、付款期限未到、沒有成功的付款、
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
        AND o.payment_deadline > ${effectiveNow}
        AND NOT EXISTS (SELECT 1 FROM payments other WHERE other.order_id = o.id AND other.status IN ('succeeded', 'pending'))
    `,
  ]);
  return inserted!.meta.changes > 0 ? inserted!.meta.last_row_id : null;
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
 *    後面每一句都要求 `won`，所以同一個事件重送或同時送達，只有第一次的寫入生效。
 * 2. （成功時）把訂單明細的數量從在庫數正式扣除。
 * 3. （成功時）訂單「僅在仍是待付款時」轉為已付款。保留因此自然消失（保留只算待付款訂單的明細）。
 *    2 與 3 用同一組條件：訂單仍是待付款、搶到事件、這筆付款還在 pending。這組條件寫在 SQL 裡而不是先讀後寫，
 *    所以同一張訂單的兩筆付款同時成功時，只有先執行的那一筆扣庫存並轉已付款；另一筆的 2、3 都是 0 列。
 *    2 必須排在 3 前面：3 執行之後訂單就不是待付款了。
 * 4. 付款轉為事件的結果，僅限仍是 pending 的付款（狀態只往前走，已成功的付款不會被後來的失敗事件蓋掉）。
 *
 * 訂單若已不是待付款（已逾期、已取消、已付款），2 與 3 都寫 0 列：付款仍記為成功，訂單與庫存不動；
 * 呼叫端據此得知「付款成功落在非待付款的訂單上」（`orderSettled` 為 false）。
 * 保留判定不看付款期限：期限已過但 Cron 還沒轉逾期時，訂單仍是待付款，保留仍在，扣除與保留一致。
 */
export async function applyPaymentEvent(
  d1: D1Database,
  event: PaymentEvent & { orderId: number },
  now: number,
): Promise<{ paymentSettled: boolean; orderSettled: boolean }> {
  const { eventId, gatewayPaymentId, orderId, outcome } = event;
  const claim = crypto.randomUUID();
  const won = sql`EXISTS (SELECT 1 FROM payment_events WHERE event_id = ${eventId} AND claim = ${claim})`;
  const paymentPending = sql`EXISTS (SELECT 1 FROM payments WHERE gateway_payment_id = ${gatewayPaymentId} AND status = 'pending')`;
  const orderPending = sql`EXISTS (SELECT 1 FROM orders WHERE id = ${orderId} AND ${payableStatusSql()})`;

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
        UPDATE products
        SET on_hand = on_hand - (SELECT line.quantity FROM order_lines line WHERE line.order_id = ${orderId} AND line.product_id = products.id)
        WHERE id IN (SELECT product_id FROM order_lines WHERE order_id = ${orderId})
          AND ${orderPending} AND ${won} AND ${paymentPending}
      `,
      sql`
        UPDATE orders SET status = 'paid'
        WHERE id = ${orderId} AND ${payableStatusSql()} AND ${won} AND ${paymentPending}
      `,
    );
  }
  statements.push(sql`
    UPDATE payments SET status = ${outcome}
    WHERE gateway_payment_id = ${gatewayPaymentId} AND status = 'pending' AND ${won}
  `);

  const results = await batchAtEffectiveNow(d1, now, statements);
  const paymentSettled = results[results.length - 1]!.meta.changes > 0;
  const orderSettled = outcome === "succeeded" && results[results.length - 2]!.meta.changes > 0;
  return { paymentSettled, orderSettled };
}

export interface PaymentSummary {
  id: number;
  amountTwd: number;
  status: PaymentStatus;
  /** 發起時間，UTC epoch 毫秒。 */
  createdAt: number;
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
  const rows = await db
    .select({
      orderId: payments.orderId,
      id: payments.id,
      amountTwd: payments.amountTwd,
      status: payments.status,
      createdAt: payments.createdAt,
      expiresAt: payments.expiresAt,
    })
    .from(payments)
    .innerJoin(orders, eq(orders.id, payments.orderId))
    .where(and(eq(orders.customerId, customerId), orderId === undefined ? undefined : eq(orders.id, orderId)))
    .orderBy(asc(payments.id));

  const byOrder = new Map<number, PaymentSummary[]>();
  for (const { orderId: owner, expiresAt, status, ...summary } of rows) {
    const displayed: PaymentStatus = status === "pending" && now >= expiresAt ? "expired" : status;
    byOrder.set(owner, [...(byOrder.get(owner) ?? []), { ...summary, status: displayed }]);
  }
  return byOrder;
}
