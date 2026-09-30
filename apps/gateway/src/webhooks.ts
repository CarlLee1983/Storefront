import { desc, eq } from "drizzle-orm";
import type { Clock } from "./clock";
import type { Db, PaymentRow } from "./payments";
import { deliveries, events } from "./schema";
import { SIGNATURE_HEADER, signWebhook } from "./webhook-signature";

export type EventRow = typeof events.$inferSelect;
export type EventType = EventRow["type"];

const DELIVERY_TIMEOUT_MS = 5_000;

/** 建立事件並固定本文；重送時逐字重用同一份本文與 eventId。 */
export async function recordEvent(db: Db, payment: PaymentRow, type: EventType, nowMs: number): Promise<EventRow> {
  const id = `evt_${crypto.randomUUID().replaceAll("-", "")}`;
  const body = JSON.stringify({
    eventId: id,
    type,
    paymentId: payment.id,
    merchantReference: payment.merchantReference,
    amountTwd: payment.amountTwd,
    occurredAt: nowMs,
  });
  const row: EventRow = { id, paymentId: payment.id, type, body, createdAt: nowMs };
  await db.insert(events).values(row);
  return row;
}

/** 投遞一次並記錄結果；對方回 2xx 才算送達，連線失敗或逾時不丟例外。 */
export async function deliverEvent(
  db: Db,
  webhookSecret: string,
  clock: Clock,
  event: EventRow,
  webhookUrl: string,
): Promise<{ delivered: boolean }> {
  const attemptedAt = clock.now();
  let statusCode: number | null = null;
  let error: string | null = null;
  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [SIGNATURE_HEADER]: await signWebhook({ secret: webhookSecret, body: event.body, nowMs: attemptedAt }),
      },
      body: event.body,
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    statusCode = response.status;
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }
  const delivered = statusCode !== null && statusCode >= 200 && statusCode < 300;
  await db.insert(deliveries).values({ eventId: event.id, attemptedAt, statusCode, delivered, error });
  return { delivered };
}

export async function listDeliveries(db: Db, eventId: string) {
  return db.select().from(deliveries).where(eq(deliveries.eventId, eventId)).orderBy(desc(deliveries.id));
}
