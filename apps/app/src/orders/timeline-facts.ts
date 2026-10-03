import { asc, eq, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { allowanceObligations } from "../invoices/schema";
import type { AllowanceStatus } from "../invoices/shared";
import { paymentEvents, payments } from "../payments/schema";
import type { PaymentOutcome } from "../payments/shared";
import { shipmentEvents, shipments, type ShipmentEventKind } from "../shipments/schema";

/**
 * 時間線需要、而各域既有檢視沒帶的業務事實時間：付款結果的套用時間、物流回報（顧客檢視不查回報）、折讓的成立與完成。
 * 三句查詢都只綁一個訂單編號（以子查詢找批次），不隨批次或付款筆數增加綁定參數（D1 上限 100）。
 */
export interface TimelineFacts {
  /** 付款的終局結果（成功／失敗）與閘道事件套用的時間；webhook、導回查詢、補查共用同一個事件，一筆付款一個結果。 */
  paymentResults: { paymentId: number; outcome: PaymentOutcome; at: number }[];
  /** 物流回報事件（舊的在前）；`id` 是回報編號，同時間的回報以它定序。 */
  shipmentEvents: { id: number; shipmentId: number; kind: ShipmentEventKind; occurredAt: number }[];
  allowances: { id: number; refundId: number; amountTwd: number; status: AllowanceStatus; issuedAt: number | null }[];
}

export async function selectTimelineFacts(db: DrizzleD1Database, orderId: number): Promise<TimelineFacts> {
  const [paymentResults, events, allowances] = await Promise.all([
    db
      .select({ paymentId: payments.id, outcome: paymentEvents.outcome, at: paymentEvents.appliedAt })
      .from(paymentEvents)
      .innerJoin(payments, eq(payments.gatewayPaymentId, paymentEvents.gatewayPaymentId))
      .where(eq(payments.orderId, orderId))
      .orderBy(asc(paymentEvents.appliedAt), asc(payments.id)),
    db
      .select({ id: shipmentEvents.id, shipmentId: shipmentEvents.shipmentId, kind: shipmentEvents.kind, occurredAt: shipmentEvents.occurredAt })
      .from(shipmentEvents)
      .where(sql`${shipmentEvents.shipmentId} IN (SELECT ${shipments.id} FROM ${shipments} WHERE ${shipments.orderId} = ${orderId})`)
      .orderBy(asc(shipmentEvents.occurredAt), asc(shipmentEvents.id)),
    db
      .select({ id: allowanceObligations.id, refundId: allowanceObligations.refundId, amountTwd: allowanceObligations.amountTwd, status: allowanceObligations.status, issuedAt: allowanceObligations.issuedAt })
      .from(allowanceObligations)
      .where(eq(allowanceObligations.orderId, orderId))
      .orderBy(asc(allowanceObligations.id)),
  ]);
  return { paymentResults, shipmentEvents: events, allowances };
}
