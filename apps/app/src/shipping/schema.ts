import { sql } from "drizzle-orm";
import { check, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * 各配送類型的現行費率（每類恰一列，遷移時寫入初始演練值：一般 NT$100、大型 NT$600）。
 * 管理員調整只影響之後的訂單：訂單把成立當下的各類實收運費寫進自己的欄位（快照），不回頭參照這張表。
 */
export const shippingRates = sqliteTable("shipping_rates", {
  deliveryType: text("delivery_type").primaryKey(),
  /** 新台幣整數元，含稅；0 表示該類型免運。 */
  feeTwd: integer("fee_twd").notNull(),
}, (table) => [
  check("shipping_rates_type_check", sql`${table.deliveryType} IN ('standard', 'large')`),
  check("shipping_rates_fee_check", sql`${table.feeTwd} >= 0`),
]);
