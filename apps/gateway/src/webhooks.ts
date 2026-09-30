import type { Clock } from "./clock";
import type { Db } from "./payments";
import { deliveries, events } from "./schema";
import { SIGNATURE_HEADER, signWebhook } from "./webhook-signature";

export type EventRow = typeof events.$inferSelect;
export type EventType = EventRow["type"];

const DELIVERY_TIMEOUT_MS = 5_000;

/**
 * 投遞一次並記錄結果；對方回 2xx 才算送達，連線失敗或逾時不丟例外。
 *
 * 呼叫端刻意在請求內同步 await 投遞，不用 ctx.waitUntil：這個閘道是測試用的模擬，
 * 同步投遞讓「付款頁送出 → webhook 已送到」的順序是決定論的，測試與手動重現遲到／重複回呼才不會有競態。
 * 不要把它「優化」成背景投遞。
 *
 * 不跟隨導向（redirect: "manual"）：webhookUrl 由呼叫端指定，跟隨 3xx 會讓閘道被導去內部網址。
 */
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
      redirect: "manual",
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
