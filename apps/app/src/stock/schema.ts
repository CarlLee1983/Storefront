import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { productVariants } from "../catalog/schema";
import { returnRequests } from "../returns/schema";
import { orders } from "../orders/schema";
import { shipmentReturns } from "../shipment-returns/schema";
import { shipments } from "../shipments/schema";

/**
 * 庫存流水的來源（ADR 0006）：管理員調整、交運扣庫、遷移加回、退貨收回入倉（在庫與不可售同增）、
 * 退貨檢查合格（不可售轉可售，在庫不變）、報廢（在庫與不可售同減），以及物流退回的收回與檢查（與退貨同一套轉換，各自的來源值，#120）。
 */
export const STOCK_MOVEMENT_KINDS = ["adjustment", "dispatch", "migration", "return_received", "return_inspected", "scrap", "shipment_return_received", "shipment_return_inspected"] as const;
export type StockMovementKind = (typeof STOCK_MOVEMENT_KINDS)[number];

/**
 * 庫存流水（Stock Ledger）：變體「在庫數」與「不可售數量」的每一次變動，只增不改不刪。
 * 保留（待付款、已付款待出貨）由訂單狀態推導，不寫流水；付款只轉換保留性質，不改在庫數，所以不會出現在這裡。
 * 每筆都在改動在庫數的同一個 batch 內寫入，且與該句條件一致，所以流水加總永遠等於在庫數的變化。
 * 新增來源不加 CHECK（否則遷移要重建資料表），合法值由寫入端限定。
 */
export const stockMovements = sqliteTable("stock_movements", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  variantId: integer("variant_id").notNull().references(() => productVariants.id),
  kind: text("kind").$type<StockMovementKind>().notNull(),
  /** 在庫數的增減量（交運為負）。 */
  delta: integer("delta").notNull(),
  /** 這筆變動之後的在庫數，供逐筆核對。 */
  onHandAfter: integer("on_hand_after").notNull(),
  /** 不可售數量的增減量（退貨收回為正、檢查合格與報廢為負）；其他來源為 0。 */
  unavailableDelta: integer("unavailable_delta").notNull().default(0),
  /** 這筆變動之後的不可售數量。#117 之前的舊流水不可售恆為 0。 */
  unavailableAfter: integer("unavailable_after").notNull().default(0),
  /** 交運扣庫時對應的訂單（每批都記）；調整為 null；遷移加回記舊已付款訂單。 */
  orderId: integer("order_id").references(() => orders.id),
  /** 交運扣庫時對應的出貨批次；其他來源與 #112 之前的舊流水為 null。 */
  shipmentId: integer("shipment_id").references(() => shipments.id),
  /** 退貨收回與檢查時對應的退貨申請；其他來源為 null。 */
  returnRequestId: integer("return_request_id").references(() => returnRequests.id),
  /** 物流退回收回與檢查時對應的物流退回案件；其他來源為 null。 */
  shipmentReturnId: integer("shipment_return_id").references(() => shipmentReturns.id),
  /** 操作人：管理員 email；系統動作（遷移）為 `system:<名稱>`。 */
  actor: text("actor").notNull(),
  /** 原因：調整由管理員填寫，交運與遷移為固定說明。 */
  reason: text("reason").notNull(),
  /** 變動時間，高水位的有效時間（UTC epoch 毫秒）。 */
  createdAt: integer("created_at").notNull(),
}, (table) => [
  index("stock_movements_variant_idx").on(table.variantId, table.id),
  index("stock_movements_order_idx").on(table.orderId),
  index("stock_movements_shipment_idx").on(table.shipmentId),
  index("stock_movements_return_idx").on(table.returnRequestId),
  index("stock_movements_shipment_return_idx").on(table.shipmentReturnId),
]);
