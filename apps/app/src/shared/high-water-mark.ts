import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { toD1Statement } from "./d1-statement";

// 高水位時鐘（Holdfast ADR 0011，https://github.com/CarlLee1983/Holdfast/blob/main/docs/adr/0011-expiry-clock-source.md）：
// 時間順序以 D1 的執行順序為準，條件讀時間的寫入一律「先推進、後寫入」，
// 並以高水位取代請求帶來的 now 當作有效時間。

/** 有效時間：語句內取代 `:now` 的 SQL 片段；只在 `batchAtEffectiveNow` 推進之後的語句裡有值。 */
export const effectiveNow: SQL<number> = sql<number>`(SELECT hwm FROM clock WHERE id = 1)`;

/** 推進高水位的 UPSERT；hwm 只增不減，空表由第一次呼叫建立。 */
const bumpClock = (now: number): SQL =>
  sql`INSERT INTO clock (id, hwm) VALUES (1, ${now}) ON CONFLICT (id) DO UPDATE SET hwm = max(hwm, excluded.hwm)`;

/**
 * 以一個 batch 先推進高水位、再依序執行 `statements`（其中的時間一律用 `effectiveNow`），
 * 回傳 `statements` 各自的結果（不含推進那句）。成敗只看目標寫入自己的 `meta.changes`，不看推進那句。
 */
export async function batchAtEffectiveNow(
  d1: D1Database,
  now: number,
  statements: SQLWrapper[],
): Promise<D1Result[]> {
  const [, ...results] = await d1.batch([
    toD1Statement(d1, bumpClock(now)),
    ...statements.map((statement) => toD1Statement(d1, statement.getSQL())),
  ]);
  return results;
}

/** 讀取端用的有效時間：`max(注入時鐘, 高水位)`，與寫入端 `effectiveNow` 推進後的值一致，讓預檢與讀取不會比寫入條件更寬或更緊。 */
export async function readEffectiveNow(db: DrizzleD1Database, now: number): Promise<number> {
  const [row] = await db.all<{ hwm: number }>(sql`SELECT hwm FROM clock WHERE id = 1`);
  return Math.max(now, row?.hwm ?? now);
}
