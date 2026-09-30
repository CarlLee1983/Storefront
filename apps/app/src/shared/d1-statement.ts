import type { SQL } from "drizzle-orm";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";

const dialect = new SQLiteSyncDialect();

/**
 * 把 drizzle 的 SQL 片段組成 D1 語句，才能與其他語句放進同一個 `d1.batch`。
 * 不用 drizzle 的 `db.run`：它在 D1 上進不了 batch（SQLiteRaw 沒有 `stmt`）。
 */
export function toD1Statement(d1: D1Database, query: SQL): D1PreparedStatement {
  const { sql: text, params } = dialect.sqlToQuery(query);
  return d1.prepare(text).bind(...params);
}
