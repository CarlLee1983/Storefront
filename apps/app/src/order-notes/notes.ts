import { asc, eq, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { batchAtEffectiveNow, effectiveNow } from "../shared/high-water-mark";
import { fail, ok } from "../shared/result";
import { orders } from "../orders/schema";
import { orderNotes } from "./schema";

export interface OrderNoteView {
  id: number;
  actor: string;
  note: string;
  /** UTC epoch 毫秒。 */
  createdAt: number;
}

/** 一張訂單的客服備註，舊的在前（對話順序）；只給管理端，顧客端的訂單讀取不經過這裡。 */
export function selectOrderNotes(db: DrizzleD1Database, orderId: number): Promise<OrderNoteView[]> {
  return db
    .select({ id: orderNotes.id, actor: orderNotes.actor, note: orderNotes.note, createdAt: orderNotes.createdAt })
    .from(orderNotes)
    .where(eq(orderNotes.orderId, orderId))
    .orderBy(asc(orderNotes.id));
}

/** 新增一則備註；訂單不存在回 `order_not_found`（由寫入句自己的條件判定，不是先讀再寫）。 */
export async function addOrderNote(
  d1: D1Database,
  { orderId, note, actor }: { orderId: number; note: string; actor: string },
  now: number,
): Promise<{ ok: true; data: { id: number } } | { ok: false; reason: "order_not_found" }> {
  const [inserted] = await batchAtEffectiveNow(d1, now, [
    sql`INSERT INTO order_notes (order_id, actor, note, created_at)
      SELECT ${orders.id}, ${actor}, ${note}, ${effectiveNow} FROM ${orders} WHERE ${orders.id} = ${orderId}
      RETURNING id`,
  ]);
  const row = inserted!.results[0] as { id: number } | undefined;
  return row ? ok({ id: row.id }) : fail("order_not_found");
}
