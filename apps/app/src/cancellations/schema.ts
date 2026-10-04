import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { orderLines, orders } from "../orders/schema";

/** 取消申請的進度：待審 → 核准或拒絕（兩者都是終點）。待審與核准都占用未交運數量，拒絕釋出（見 `cancellations/queries.ts`）。 */
export const CANCELLATION_STATUSES = ["pending", "approved", "rejected"] as const;
export type CancellationStatus = (typeof CANCELLATION_STATUSES)[number];

/**
 * 取消申請（Cancellation Request，CONTEXT.md）：顧客要求停止履行已付款但未交運的指定數量，由管理員審核（ADR 0007）。
 * 申請成立當下，待審數量就不可再交運（仍占已付款保留）；核准後取消並釋放保留、登記一筆獨立的退款（`refunds.cancellation_request_id`），
 * 退款是否成功不改變取消結果；拒絕後數量恢復可交運。明細只增不改。
 * `request_key` 是顧客一次提交的冪等鍵（同一張訂單同一個鍵只會建立一案），`request_hash` 綁定內容，同鍵不同內容靠它認出來。
 * 退款金額在核准的同一句 UPDATE 算定並寫入（`goods_twd`、`*_shipping_twd`，核准前為 null），之後不變：
 * 運費欄位同時是「這一類原運費已退過」的紀錄，讓任何核准順序下同一類運費最多退一次。
 */
export const cancellationRequests = sqliteTable(
  "cancellation_requests",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    orderId: integer("order_id").notNull().references(() => orders.id),
    requestKey: text("request_key").notNull(),
    requestHash: text("request_hash").notNull(),
    status: text("status", { enum: CANCELLATION_STATUSES }).notNull().default("pending"),
    /** 顧客填的申請原因，可為空字串。 */
    reason: text("reason").notNull().default(""),
    /** 申請時間，UTC epoch 毫秒（高水位時鐘的有效時間）。 */
    requestedAt: integer("requested_at").notNull(),
    /** 審核時間與審核人（管理員 email）；待審為 null。 */
    decidedAt: integer("decided_at"),
    decidedBy: text("decided_by"),
    /** 管理員審核備註（核准或拒絕的原因），可為空字串；待審為 null。 */
    decisionNote: text("decision_note"),
    /** 核准時算定的退款拆分：商品款（按原實付單價）與各配送類型的原運費（同類全數取消才退，否則 0）；待審與拒絕為 null。 */
    goodsTwd: integer("goods_twd"),
    standardShippingTwd: integer("standard_shipping_twd"),
    largeShippingTwd: integer("large_shipping_twd"),
  },
  (table) => [
    uniqueIndex("cancellation_requests_order_key_uidx").on(table.orderId, table.requestKey),
    index("cancellation_requests_status_idx").on(table.status),
    check("cancellation_requests_status_check", sql`${table.status} IN ('pending', 'approved', 'rejected')`),
    check(
      "cancellation_requests_decision_check",
      sql`(${table.status} = 'pending') = (${table.decidedAt} IS NULL) AND (${table.status} = 'approved') = (${table.goodsTwd} IS NOT NULL)`,
    ),
  ],
);

/** 申請明細：哪筆訂單明細取消多少數量；同一明細各案（待審與核准）加總不得超過「明細數量 − 已交運」（寫入端條件保證）。 */
export const cancellationRequestItems = sqliteTable(
  "cancellation_request_items",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    requestId: integer("request_id").notNull().references(() => cancellationRequests.id),
    orderLineId: integer("order_line_id").notNull().references(() => orderLines.id),
    quantity: integer("quantity").notNull(),
  },
  (table) => [
    uniqueIndex("cancellation_request_items_request_line_uidx").on(table.requestId, table.orderLineId),
    // 占用數量依明細加總
    index("cancellation_request_items_line_idx").on(table.orderLineId),
    check("cancellation_request_items_quantity_check", sql`${table.quantity} > 0`),
  ],
);
