import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { orderLines, orders } from "../orders/schema";

export const DELIVERY_STATUSES = ["in_transit", "delivery_failed", "delivered", "lost"] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/** 物流回報的種類：送達、配送失敗、再次配送（物流仍持有原貨，重新安排交付）。 */
export const SHIPMENT_EVENT_KINDS = ["delivered", "delivery_failed", "redelivery"] as const;
export type ShipmentEventKind = (typeof SHIPMENT_EVENT_KINDS)[number];

/**
 * 出貨批次（Shipment，CONTEXT.md）：一張訂單一次交運的明細數量集合，明細只增不改；批次的配送進度與送達（#113）、
 * 部分取消（#116）、依各批送達日退貨（#118）都以它為單位延伸。
 * 整單的出貨進度由「各明細已交運數量（批次明細加總）」與訂單狀態一起表達；每批的配送進度（`deliveryStatus`）與實際送達時間各自記在批次上。
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
  /**
   * 配送進度，由物流回報事件（`shipmentEvents`）與確認遺失（`shipmentLosses`）推導而來、不接受直接寫入：
   * 有確認遺失就是 `lost`（管理員確認、已退款的結局，最優先；之後才到的送達、失敗、再次配送回報只留紀錄，不改進度）；
   * 否則已送達為終點（之後到達的失敗、再次配送回報只留紀錄，不改進度），其餘依回報發生時間最新的一筆決定：配送失敗 → `delivery_failed`，再次配送或沒有回報 → `in_transit`。
   * 再次配送是同一批原貨再交付，不新增出貨數量、不扣庫、不建新批次。配送失敗只是暫時異常，不會變成遺失，遺失一定來自管理員的確認。
   */
  deliveryStatus: text("delivery_status", { enum: DELIVERY_STATUSES }).notNull().default("in_transit"),
  /** 實際送達時間（UTC epoch 毫秒），取送達回報中發生時間最早的一筆；未送達為 null。遷移補建的舊批次沒有可靠送達日，保持 null，不編造（#118 走人工受理）。 */
  deliveredAt: integer("delivered_at"),
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

/**
 * 物流回報事件（模擬物流）：只增不改的對帳紀錄。`eventKey` 是物流給的事件識別，同一批同一個鍵只會有一筆，重送不重複；
 * 事件可延遲、重送、亂序到達，進度與送達時間一律由全部事件重新推導（見 `shipments/events.ts`），不看到達順序。
 * `occurredAt` 是物流回報事件發生的時間，`recordedAt` 是系統收到並記錄的時間（高水位的有效時間）。
 */
export const shipmentEvents = sqliteTable("shipment_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  shipmentId: integer("shipment_id").notNull().references(() => shipments.id),
  eventKey: text("event_key").notNull(),
  kind: text("kind", { enum: SHIPMENT_EVENT_KINDS }).notNull(),
  occurredAt: integer("occurred_at").notNull(),
  recordedAt: integer("recorded_at").notNull(),
  /** 記錄這筆回報的管理員 email。 */
  actor: text("actor").notNull(),
}, (table) => [
  uniqueIndex("shipment_events_shipment_key_uidx").on(table.shipmentId, table.eventKey),
  check("shipment_events_kind_check", sql`${table.kind} IN ('delivered', 'delivery_failed', 'redelivery')`),
]);

/**
 * 確認遺失（Confirmed Loss，CONTEXT.md）：管理員確認某一批的部分商品數量遺失、無法交付，一案一筆（`loss_key` 是管理員表單一次提交的冪等鍵，`request_hash` 綁定內容）。
 * 只能確認尚未送達的批次（已送達是終點）；遺失的數量須在「批次數量 − 該批自助退貨占用」與「明細已交運 − 退貨占用 − 其他遺失」之內，與退貨申請共用同一份數量（見 `shipments/loss.ts`）。
 * 遺失不回補庫存（貨已交運、不在倉內，ADR 0006），也不從同單補寄；退款拆分在建立時算定（商品款按原實付單價，各配送類型的原運費只在該類沒退過時退一次），
 * 在同一個 batch 登記退款（`refunds.shipment_loss_id`，一案一筆）。運費欄位同時是「這一類原運費已退過」的紀錄（與取消、退貨共用，見 `payments/exit-refund.ts`）。
 */
export const shipmentLosses = sqliteTable("shipment_losses", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  orderId: integer("order_id").notNull().references(() => orders.id),
  shipmentId: integer("shipment_id").notNull().references(() => shipments.id),
  lossKey: text("loss_key").notNull(),
  requestHash: text("request_hash").notNull(),
  /** 管理員備註（例如物流查證結果），可為空字串。 */
  note: text("note").notNull().default(""),
  /** 確認時間，UTC epoch 毫秒（高水位時鐘的有效時間）與確認人（管理員 email）。 */
  confirmedAt: integer("confirmed_at").notNull(),
  actor: text("actor").notNull(),
  /** 建立時算定的退款拆分：商品款與各配送類型的原運費。 */
  goodsTwd: integer("goods_twd").notNull(),
  standardShippingTwd: integer("standard_shipping_twd").notNull(),
  largeShippingTwd: integer("large_shipping_twd").notNull(),
}, (table) => [
  uniqueIndex("shipment_losses_shipment_key_uidx").on(table.shipmentId, table.lossKey),
  index("shipment_losses_order_idx").on(table.orderId),
]);

/** 確認遺失的明細：哪筆訂單明細遺失多少數量，建立後不變。 */
export const shipmentLossItems = sqliteTable("shipment_loss_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  lossId: integer("loss_id").notNull().references(() => shipmentLosses.id),
  orderLineId: integer("order_line_id").notNull().references(() => orderLines.id),
  quantity: integer("quantity").notNull(),
}, (table) => [
  uniqueIndex("shipment_loss_items_loss_line_uidx").on(table.lossId, table.orderLineId),
  index("shipment_loss_items_line_idx").on(table.orderLineId),
  check("shipment_loss_items_quantity_check", sql`${table.quantity} > 0`),
]);
