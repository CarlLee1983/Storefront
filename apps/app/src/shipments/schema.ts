import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { orderLines, orders } from "../orders/schema";

/**
 * 出貨批次（Shipment，CONTEXT.md）：一張訂單一次交運的明細數量集合，只增不改；批次的進度與送達（#113）、
 * 部分取消（#116）、依各批送達日退貨（#118）都以它為單位延伸。批次沒有自己的狀態欄位，那些票再加。
 * 整單的出貨進度由「各明細已交運數量（批次明細加總）」與訂單狀態一起表達。
 */
export const shipments = sqliteTable("shipments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  orderId: integer("order_id").notNull().references(() => orders.id),
  /** 管理員表單一次提交的冪等鍵：同一張訂單同一個鍵只會建立一批，重送回原批次，不重複扣庫也不再次通知。遷移補建的舊批次為 `legacy:0021`（輸入驗證不接受冒號，一般交運產生不出這個鍵）。 */
  dispatchKey: text("dispatch_key").notNull(),
  /** 交運內容（明細、物流單號、時段）的 SHA-256 hex；同一個冪等鍵帶不同內容時靠它認出來。遷移補建的舊批次為 null，也用來區分「本次 batch 新建」與既有批次。
   * 不變式：`request_hash` 不為空的批次必在建立它的同一個 batch 內寫庫存流水（`shipments/dispatch.ts` 的扣庫條件靠「有指紋且沒有流水」認出本次新建的批次）；其他建立批次的路徑不得填 `request_hash`。 */
  requestHash: text("request_hash"),
  /** 物流單號；可空（交運時可以不附）。 */
  trackingNumber: text("tracking_number"),
  /** 大型配送與顧客議定的預約時段（UTC epoch 毫秒，起訖成對）；只記錄，不做司機容量排程。沒有議定（一般宅配）為 null。 */
  appointmentStart: integer("appointment_start"),
  appointmentEnd: integer("appointment_end"),
  /** 交運時間，高水位的有效時間（UTC epoch 毫秒）；遷移補建的舊批次若舊訂單沒有出貨時間則為 null，不編造。 */
  shippedAt: integer("shipped_at"),
  /** 操作人：管理員 email；遷移補建為 `system:<名稱>`。 */
  actor: text("actor").notNull(),
}, (table) => [
  uniqueIndex("shipments_order_key_uidx").on(table.orderId, table.dispatchKey),
  check("shipments_appointment_check", sql`(${table.appointmentStart} IS NULL) = (${table.appointmentEnd} IS NULL) AND (${table.appointmentStart} IS NULL OR ${table.appointmentEnd} > ${table.appointmentStart})`),
]);

/** 批次明細：這一批交運了哪筆訂單明細的多少數量；同一明細各批數量加總不得超過明細數量（寫入端條件保證）。 */
export const shipmentItems = sqliteTable("shipment_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  shipmentId: integer("shipment_id").notNull().references(() => shipments.id),
  orderLineId: integer("order_line_id").notNull().references(() => orderLines.id),
  quantity: integer("quantity").notNull(),
}, (table) => [
  uniqueIndex("shipment_items_shipment_line_uidx").on(table.shipmentId, table.orderLineId),
  // 已交運數量依明細加總
  index("shipment_items_line_idx").on(table.orderLineId),
  check("shipment_items_quantity_check", sql`${table.quantity} > 0`),
]);
