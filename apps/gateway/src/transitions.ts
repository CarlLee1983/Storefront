import type { Db, PaymentRow, PaymentStatus } from "./payments";
import type { EventRow, EventType } from "./webhooks";

function buildEvent(payment: PaymentRow, type: EventType, nowMs: number): EventRow {
  const id = `evt_${crypto.randomUUID().replaceAll("-", "")}`;
  const body = JSON.stringify({
    eventId: id,
    type,
    paymentId: payment.id,
    merchantReference: payment.merchantReference,
    amountTwd: payment.amountTwd,
    occurredAt: nowMs,
  });
  return { id, paymentId: payment.id, type, body, createdAt: nowMs };
}

export interface Transition {
  from: PaymentStatus[];
  to: PaymentStatus;
  event: EventType;
  /** 只在這個時間點之前有效的轉換（付款頁送出用）：`expires_at > nowMs`。 */
  requireUnexpired?: boolean;
}

/**
 * 狀態轉換與事件建立在同一個 `db.batch`（D1 把 batch 當成一個交易：任何一句失敗就整批回滾）：
 *
 * 1. 條件式 UPDATE：只有目前狀態在 `from` 內（且未過期）才轉成 `to`；
 * 2. `INSERT … SELECT … FROM payments WHERE id = ? AND status = <to> ON CONFLICT DO NOTHING`：
 *    在同一個交易裡讀到剛更新的狀態才插入事件，並由 (payment_id, type) 唯一索引擋下重複。
 *
 * 所以「狀態已轉換但沒有事件」不可能發生：UPDATE 生效時，第二句一定看得到 `status = <to>` 而插入成功；
 * UPDATE 沒生效（別的請求已轉換）時不會另外造出事件。這裡刻意不用 `changes()`，改看資料本身的狀態。
 * 對外投遞（HTTP）不在交易裡，失敗也不會讓狀態與事件不一致——事件已存檔，可由主控頁重送。
 *
 * 回傳新建立的事件；沒有轉換（狀態不符、已過期、被別人搶先）回 null。
 */
export async function transitionWithEvent(
  db: Db,
  payment: PaymentRow,
  transition: Transition,
  nowMs: number,
): Promise<EventRow | null> {
  const event = buildEvent(payment, transition.event, nowMs);
  const statusList = transition.from.map(() => "?").join(", ");
  const expiryClause = transition.requireUnexpired ? " AND expires_at > ?" : "";
  const d1 = db.$client;

  const update = d1
    .prepare(`UPDATE payments SET status = ? WHERE id = ? AND status IN (${statusList})${expiryClause}`)
    .bind(transition.to, payment.id, ...transition.from, ...(transition.requireUnexpired ? [nowMs] : []));
  const insertEvent = d1
    .prepare(
      `INSERT INTO events (id, payment_id, type, body, created_at)
       SELECT ?, id, ?, ?, ? FROM payments WHERE id = ? AND status = ?
       ON CONFLICT DO NOTHING`,
    )
    .bind(event.id, event.type, event.body, event.createdAt, payment.id, transition.to);

  const [updated] = await d1.batch([update, insertEvent]);
  return updated!.meta.changes > 0 ? event : null;
}
