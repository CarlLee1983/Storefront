import { and, desc, eq, lt, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { productVariants, products } from "../catalog/schema";
import { stockMovements, type StockMovementKind } from "./schema";

export interface StockMovementView {
  id: number;
  variantId: number;
  productName: string;
  /** 變體選項值以「 / 」相連；沒有選項的商品為空字串。 */
  variantLabel: string;
  kind: StockMovementKind;
  delta: number;
  onHandAfter: number;
  /** 不可售數量的增減量（退貨收回為正、檢查合格與報廢為負）；其他來源為 0。 */
  unavailableDelta: number;
  /** 這筆變動之後的不可售數量。 */
  unavailableAfter: number;
  /** 退貨收回與檢查對應的退貨申請；其他來源為 null。 */
  returnRequestId: number | null;
  orderId: number | null;
  actor: string;
  reason: string;
  /** UTC epoch 毫秒。 */
  createdAt: number;
}

export interface MovementQuery {
  variantId?: number;
  orderId?: number;
  /** 游標：只取編號小於它的（上一頁最後一筆的編號）。 */
  beforeId?: number;
  limit: number;
}

/** 讀庫存流水，新的在前；多讀一筆判斷是否還有下一頁，`nextBeforeId` 為下一頁的游標（沒有下一頁為 null）。 */
export async function selectStockMovements(
  db: DrizzleD1Database,
  { variantId, orderId, beforeId, limit }: MovementQuery,
): Promise<{ items: StockMovementView[]; nextBeforeId: number | null }> {
  const rows = await db
    .select({
      id: stockMovements.id,
      variantId: stockMovements.variantId,
      productName: products.name,
      variantLabel: sql<string>`${productVariants.option1Value} || CASE WHEN ${productVariants.option2Value} <> '' THEN ' / ' || ${productVariants.option2Value} ELSE '' END`,
      kind: stockMovements.kind,
      delta: stockMovements.delta,
      onHandAfter: stockMovements.onHandAfter,
      unavailableDelta: stockMovements.unavailableDelta,
      unavailableAfter: stockMovements.unavailableAfter,
      returnRequestId: stockMovements.returnRequestId,
      orderId: stockMovements.orderId,
      actor: stockMovements.actor,
      reason: stockMovements.reason,
      createdAt: stockMovements.createdAt,
    })
    .from(stockMovements)
    .innerJoin(productVariants, eq(productVariants.id, stockMovements.variantId))
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(and(
      variantId === undefined ? undefined : eq(stockMovements.variantId, variantId),
      orderId === undefined ? undefined : eq(stockMovements.orderId, orderId),
      beforeId === undefined ? undefined : lt(stockMovements.id, beforeId),
    ))
    .orderBy(desc(stockMovements.id))
    .limit(limit + 1);
  const items = rows.slice(0, limit);
  return { items, nextBeforeId: rows.length > limit ? items[items.length - 1]!.id : null };
}
