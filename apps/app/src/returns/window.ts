import { sql, type SQL } from "drizzle-orm";

/** 自助退貨窗口天數：實際送達的隔日起算 7 天（設計文件 Q28）。 */
export const RETURN_WINDOW_DAYS = 7;

/** 以日為單位的邊界一律看台北日曆日（UTC+8，台灣沒有日光節約）。 */
const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 自助窗口的結束時間（不含，UTC epoch 毫秒）：送達日（台北）的隔日為第 1 天，第 7 天的 23:59:59.999 之後（第 8 天 00:00:00）窗口關閉。
 * 送達當日本身可以申請（顧客已收到商品），所以窗口是 [送達時間, 送達日 + 8 天的台北 00:00)。
 */
export function returnWindowEnd(deliveredAt: number): number {
  return Math.floor((deliveredAt + TAIPEI_OFFSET_MS) / DAY_MS) * DAY_MS - TAIPEI_OFFSET_MS + (RETURN_WINDOW_DAYS + 1) * DAY_MS;
}

/** `returnWindowEnd` 的 SQL 版本（寫入端的條件用，與 TypeScript 版本須一致，由邊界測試把關）。 */
export function returnWindowEndSql(deliveredAt: SQL): SQL<number> {
  return sql<number>`((${deliveredAt} + ${TAIPEI_OFFSET_MS}) / ${DAY_MS}) * ${DAY_MS} - ${TAIPEI_OFFSET_MS} + ${(RETURN_WINDOW_DAYS + 1) * DAY_MS}`;
}

/** 一批的自助窗口狀態：沒有可靠送達時間（未送達、遷移補建的舊批次）不開放自助，保留人工受理，不補假日期。 */
export type ReturnWindowState = "not_delivered" | "open" | "closed";

export function returnWindowState(deliveredAt: number | null, now: number): ReturnWindowState {
  if (deliveredAt === null || deliveredAt > now) return "not_delivered";
  return now < returnWindowEnd(deliveredAt) ? "open" : "closed";
}
