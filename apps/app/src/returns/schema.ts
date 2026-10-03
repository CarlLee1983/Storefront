import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { orderLines, orders } from "../orders/schema";

/**
 * 退貨申請的進度：待審 → 核准或拒絕；核准後管理員記錄收回（`received`，或一件都沒收到而 `not_received` 結案），
 * 收回後記錄檢查（`completed`）並登記退款。拒絕、未收到、完成是終點。
 */
export const RETURN_STATUSES = ["pending", "approved", "rejected", "received", "not_received", "completed"] as const;
export type ReturnStatus = (typeof RETURN_STATUSES)[number];

/**
 * 退貨申請（Return Request，CONTEXT.md）：顧客在訂單上指定變體明細與數量、要求退貨，由管理員審核並安排收回（ADR 0006、0007）。
 * 實物與款項分開記錄：收回才增加實體在庫與不可售（庫存流水 `return_received`）、檢查合格才把不可售轉可售、損壞品留在不可售直到報廢；
 * 退款在檢查完成的同一個 batch 登記（`refunds.return_request_id`，一案一筆），退款失敗不反轉已發生的實物事件。
 * `request_key` 是顧客一次提交的冪等鍵，`request_hash` 綁定內容；退款拆分在檢查完成的同一句 UPDATE 算定（`goods_twd`、`*_shipping_twd`，之前為 null），
 * 運費欄位同時是「這一類原運費已退過」的紀錄（與取消共用，見 `payments/exit-refund.ts`）。
 */
export const returnRequests = sqliteTable(
  "return_requests",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    orderId: integer("order_id").notNull().references(() => orders.id),
    requestKey: text("request_key").notNull(),
    requestHash: text("request_hash").notNull(),
    status: text("status", { enum: RETURN_STATUSES }).notNull().default("pending"),
    /** 顧客填的申請原因，可為空字串。 */
    reason: text("reason").notNull().default(""),
    /** 申請時間，UTC epoch 毫秒（高水位時鐘的有效時間）。 */
    requestedAt: integer("requested_at").notNull(),
    /** 審核時間、審核人（管理員 email）與備註；待審為 null。 */
    decidedAt: integer("decided_at"),
    decidedBy: text("decided_by"),
    decisionNote: text("decision_note"),
    /** 收回記錄的時間、操作人與備註；尚未記錄為 null。 */
    receivedAt: integer("received_at"),
    receivedBy: text("received_by"),
    receiptNote: text("receipt_note"),
    /** 檢查記錄的時間、操作人與備註；尚未檢查為 null。 */
    inspectedAt: integer("inspected_at"),
    inspectedBy: text("inspected_by"),
    inspectionNote: text("inspection_note"),
    /** 檢查完成時算定的退款拆分：商品款（實際收回數量按原實付單價）與各配送類型的原運費；完成之前為 null。 */
    goodsTwd: integer("goods_twd"),
    standardShippingTwd: integer("standard_shipping_twd"),
    largeShippingTwd: integer("large_shipping_twd"),
  },
  (table) => [
    uniqueIndex("return_requests_order_key_uidx").on(table.orderId, table.requestKey),
    index("return_requests_status_idx").on(table.status),
    check("return_requests_status_check", sql`${table.status} IN ('pending', 'approved', 'rejected', 'received', 'not_received', 'completed')`),
    check(
      "return_requests_progress_check",
      sql`(${table.status} = 'pending') = (${table.decidedAt} IS NULL) AND (${table.status} = 'completed') = (${table.goodsTwd} IS NOT NULL) AND (${table.status} IN ('received', 'not_received', 'completed')) = (${table.receivedAt} IS NOT NULL)`,
    ),
  ],
);

/**
 * 申請明細：哪筆訂單明細退多少數量（`quantity`，申請與核准的數量）；收回與檢查再各記實際數字，之後不變：
 * `received_quantity`（實際收到，不超過申請）、`sellable_quantity`／`damaged_quantity`（檢查結果，兩者相加等於實際收到）。
 * 同一明細各案占用數量加總不得超過「已交運數量」（寫入端條件保證，見 `returns/queries.ts` 的 `heldByReturnQuantity`）。
 */
export const returnRequestItems = sqliteTable(
  "return_request_items",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    requestId: integer("request_id").notNull().references(() => returnRequests.id),
    orderLineId: integer("order_line_id").notNull().references(() => orderLines.id),
    quantity: integer("quantity").notNull(),
    receivedQuantity: integer("received_quantity"),
    sellableQuantity: integer("sellable_quantity"),
    damagedQuantity: integer("damaged_quantity"),
  },
  (table) => [
    uniqueIndex("return_request_items_request_line_uidx").on(table.requestId, table.orderLineId),
    index("return_request_items_line_idx").on(table.orderLineId),
    check("return_request_items_quantity_check", sql`${table.quantity} > 0`),
    check("return_request_items_received_check", sql`${table.receivedQuantity} IS NULL OR (${table.receivedQuantity} >= 0 AND ${table.receivedQuantity} <= ${table.quantity})`),
    check(
      "return_request_items_inspection_check",
      sql`(${table.sellableQuantity} IS NULL) = (${table.damagedQuantity} IS NULL) AND (${table.sellableQuantity} IS NULL OR (${table.sellableQuantity} >= 0 AND ${table.damagedQuantity} >= 0 AND ${table.sellableQuantity} + ${table.damagedQuantity} = ${table.receivedQuantity}))`,
    ),
  ],
);
