import { integer, sqliteTable } from "drizzle-orm/sqlite-core";

/**
 * 全域高水位時鐘（Holdfast ADR 0011，https://github.com/CarlLee1983/Holdfast/blob/main/docs/adr/0011-expiry-clock-source.md）：
 * 單列表，`id` 恆為 1，`hwm` 只增不減。條件讀時間的寫入先推進它，再以它當有效時間（見 `high-water-mark.ts`）。
 */
export const clock = sqliteTable("clock", {
  id: integer("id").primaryKey(),
  /** 高水位，UTC epoch 毫秒。 */
  hwm: integer("hwm").notNull(),
});
