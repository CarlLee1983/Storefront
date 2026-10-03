import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { orderLines, orders } from "../orders/schema";
import { shipments } from "../shipments/schema";

/**
 * 物流退回的進度：管理員登記物流把這批商品送回倉庫（`returning`）→ 實際收到後記錄收回（`received`，一件都沒收到則 `not_received` 結案）→ 檢查完成（`completed`）並登記退款。
 * 未收到與完成是終點。
 */
export const SHIPMENT_RETURN_STATUSES = ["returning", "received", "not_received", "completed"] as const;
export type ShipmentReturnStatus = (typeof SHIPMENT_RETURN_STATUSES)[number];

/**
 * 物流退回案件（Return to Sender，CONTEXT.md）：出貨商品因配送異常由物流送回倉庫，與顧客收貨後的退貨申請分開記錄（ADR 0006、0007）。
 * 只能對尚未送達的批次登記（已送達是終點）；實物與款項分開記錄，沿用退貨的庫存轉換：實際收回才增加實體在庫與不可售（待檢）、檢查合格轉可售、損壞品留在不可售直到報廢（見 `stock/conversion.ts`）；
 * 退款在檢查完成的同一個 batch 登記（`refunds.shipment_return_id`，一案一筆），退款失敗不反轉已發生的實物事件。
 * `return_key` 是管理員表單一次提交的冪等鍵，`request_hash` 綁定內容；退款拆分在檢查完成的同一句 UPDATE 算定（`goods_twd`、`*_shipping_twd`，之前為 null），
 * 運費欄位同時是「這一類原運費已退過」的紀錄（與取消、退貨、遺失共用，見 `payments/exit-refund.ts`）。
 * 回倉後不恢復原單履約：已交運的數量維持已交運，不從同單補寄，再購須重新下單。
 */
export const shipmentReturns = sqliteTable(
  "shipment_returns",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    orderId: integer("order_id").notNull().references(() => orders.id),
    shipmentId: integer("shipment_id").notNull().references(() => shipments.id),
    returnKey: text("return_key").notNull(),
    requestHash: text("request_hash").notNull(),
    status: text("status", { enum: SHIPMENT_RETURN_STATUSES }).notNull().default("returning"),
    /** 管理員備註（例如物流退回單號），可為空字串。 */
    note: text("note").notNull().default(""),
    /** 登記時間，UTC epoch 毫秒（高水位時鐘的有效時間）與登記人（管理員 email）。 */
    declaredAt: integer("declared_at").notNull(),
    actor: text("actor").notNull(),
    /** 收回記錄的時間、操作人與備註；尚未記錄為 null。 */
    receivedAt: integer("received_at"),
    receivedBy: text("received_by"),
    receiptNote: text("receipt_note"),
    /** 檢查記錄的時間、操作人與備註；尚未檢查為 null。 */
    inspectedAt: integer("inspected_at"),
    inspectedBy: text("inspected_by"),
    inspectionNote: text("inspection_note"),
    /** 檢查完成時算定的退款拆分：商品款（實際收回、尚未退款的數量按原實付單價）與各配送類型的原運費；完成之前為 null。 */
    goodsTwd: integer("goods_twd"),
    standardShippingTwd: integer("standard_shipping_twd"),
    largeShippingTwd: integer("large_shipping_twd"),
  },
  (table) => [
    uniqueIndex("shipment_returns_shipment_key_uidx").on(table.shipmentId, table.returnKey),
    index("shipment_returns_order_idx").on(table.orderId),
    index("shipment_returns_status_idx").on(table.status),
    check("shipment_returns_status_check", sql`${table.status} IN ('returning', 'received', 'not_received', 'completed')`),
    check(
      "shipment_returns_progress_check",
      sql`(${table.status} = 'completed') = (${table.goodsTwd} IS NOT NULL) AND (${table.status} IN ('received', 'not_received', 'completed')) = (${table.receivedAt} IS NOT NULL)`,
    ),
  ],
);

/**
 * 物流退回明細：哪筆訂單明細退回多少數量。
 * `quantity` 是這批仍有效的交運數量中被退回的（收回後按原實付單價退款）；`found_lost_quantity` 是先前已確認遺失並退款、之後被物流尋回並退回倉庫的數量：
 * 收回時照樣入庫（實物回到倉內），但已經退過款，不再退（見 `shipment-returns/declare.ts`）。
 * 收回與檢查再各記實際數字，之後不變：`received_quantity`（不超過 `quantity`）、`received_found_lost_quantity`（不超過 `found_lost_quantity`）、
 * `sellable_quantity`／`damaged_quantity`（檢查結果，兩者相加等於兩種實際收到數量之和）。
 */
export const shipmentReturnItems = sqliteTable(
  "shipment_return_items",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    returnId: integer("return_id").notNull().references(() => shipmentReturns.id),
    orderLineId: integer("order_line_id").notNull().references(() => orderLines.id),
    quantity: integer("quantity").notNull(),
    foundLostQuantity: integer("found_lost_quantity").notNull().default(0),
    receivedQuantity: integer("received_quantity"),
    receivedFoundLostQuantity: integer("received_found_lost_quantity"),
    sellableQuantity: integer("sellable_quantity"),
    damagedQuantity: integer("damaged_quantity"),
  },
  (table) => [
    uniqueIndex("shipment_return_items_return_line_uidx").on(table.returnId, table.orderLineId),
    index("shipment_return_items_line_idx").on(table.orderLineId),
    check("shipment_return_items_quantity_check", sql`${table.quantity} >= 0 AND ${table.foundLostQuantity} >= 0 AND ${table.quantity} + ${table.foundLostQuantity} > 0`),
    check(
      "shipment_return_items_received_check",
      sql`(${table.receivedQuantity} IS NULL) = (${table.receivedFoundLostQuantity} IS NULL) AND (${table.receivedQuantity} IS NULL OR (${table.receivedQuantity} >= 0 AND ${table.receivedQuantity} <= ${table.quantity} AND ${table.receivedFoundLostQuantity} >= 0 AND ${table.receivedFoundLostQuantity} <= ${table.foundLostQuantity}))`,
    ),
    check(
      "shipment_return_items_inspection_check",
      sql`(${table.sellableQuantity} IS NULL) = (${table.damagedQuantity} IS NULL) AND (${table.sellableQuantity} IS NULL OR (${table.sellableQuantity} >= 0 AND ${table.damagedQuantity} >= 0 AND ${table.sellableQuantity} + ${table.damagedQuantity} = ${table.receivedQuantity} + ${table.receivedFoundLostQuantity}))`,
    ),
  ],
);
