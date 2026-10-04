import { asc, eq, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { orderLines } from "../orders/schema";
import { heldByShipmentReturnQuantity, returnedInBatchQuantity } from "../shipment-returns/quantities";
import { dispatchedQuantity, lostInBatchQuantity, lostQuantity } from "../shipments/queries";
import { shipmentItems, shipments } from "../shipments/schema";
import { heldByReturnBatchQuantity, heldByReturnQuantity } from "./queries";
import { returnWindowEnd, returnWindowState, type ReturnWindowState } from "./window";

/** 顧客看到的一批：自助窗口狀態與各明細此刻還能自助申請的數量（只有 `open` 的批次才有大於 0 的數量）。 */
export interface ReturnBatchView {
  shipmentId: number;
  /** 實際送達時間，UTC epoch 毫秒；未送達或沒有可靠送達日為 null（走人工受理）。 */
  deliveredAt: number | null;
  /** 自助窗口結束時間（不含），UTC epoch 毫秒；沒有送達時間為 null。 */
  windowEndsAt: number | null;
  state: ReturnWindowState;
  items: { orderLineId: number; productName: string; variantLabel: string; quantity: number; selfServiceQuantity: number }[];
}

/**
 * 一張訂單各批的自助退貨窗口。可自助申請的數量 = min(該批數量 − 該批已被自助占用 − 該批已遺失 − 該批物流退回, 明細層「已交運 − 占用 − 遺失 − 物流退回」)，
 * 和寫入端（`returns/request.ts`）的條件同一個算式；窗口依「當下」的送達時間計算，送達時間被較早的回報改寫後期限隨之改變。
 */
export async function selectReturnBatches(db: DrizzleD1Database, orderId: number, now: number): Promise<ReturnBatchView[]> {
  const rows = await db
    .select({
      shipmentId: shipments.id,
      deliveredAt: shipments.deliveredAt,
      orderLineId: shipmentItems.orderLineId,
      productName: orderLines.productName,
      variantLabel: orderLines.variantLabel,
      quantity: shipmentItems.quantity,
      selfServiceQuantity: sql<number>`MAX(0, MIN(${shipmentItems.quantity} - ${heldByReturnBatchQuantity(sql`${shipmentItems.orderLineId}`, sql`${shipments.id}`)} - ${lostInBatchQuantity(sql`${shipmentItems.orderLineId}`, sql`${shipments.id}`)} - ${returnedInBatchQuantity(sql`${shipmentItems.orderLineId}`, sql`${shipments.id}`)}, ${dispatchedQuantity(sql`${shipmentItems.orderLineId}`)} - ${heldByReturnQuantity(sql`${shipmentItems.orderLineId}`)} - ${lostQuantity(sql`${shipmentItems.orderLineId}`)} - ${heldByShipmentReturnQuantity(sql`${shipmentItems.orderLineId}`)}))`,
    })
    .from(shipments)
    .innerJoin(shipmentItems, eq(shipmentItems.shipmentId, shipments.id))
    .innerJoin(orderLines, eq(orderLines.id, shipmentItems.orderLineId))
    .where(eq(shipments.orderId, orderId))
    .orderBy(asc(shipments.id), asc(shipmentItems.id));

  const byShipment = new Map<number, ReturnBatchView>();
  for (const { shipmentId, deliveredAt, selfServiceQuantity, ...item } of rows) {
    const state = returnWindowState(deliveredAt, now);
    const batch = byShipment.get(shipmentId) ?? { shipmentId, deliveredAt, windowEndsAt: state === "not_delivered" || deliveredAt === null ? null : returnWindowEnd(deliveredAt), state, items: [] };
    batch.items.push({ ...item, selfServiceQuantity: state === "open" ? selfServiceQuantity : 0 });
    byShipment.set(shipmentId, batch);
  }
  return [...byShipment.values()];
}
