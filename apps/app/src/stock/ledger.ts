import { and, desc, eq, lt, sql, type SQL } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { productVariants, products } from "../catalog/schema";
import { effectiveNow } from "../shared/high-water-mark";
import { stockMovements, type StockMovementKind } from "./schema";

/**
 * 交運扣庫（ADR 0006）的兩句寫入：先寫流水、再扣在庫數，兩句用同一個條件 `orderIsDispatchable`（訂單此刻仍可交運），
 * 與緊接其後的訂單狀態轉換放在同一個 batch，所以交運成功才有扣庫與流水，被擋下（重複出貨、非已付款）時兩者都不動。
 * 流水先於扣庫：`on_hand_after` 由扣庫前的在庫數算出。扣除量就是訂單明細數量，同時消耗已付款保留（訂單離開已付款），可售數量不變。
 */
export function dispatchStatements(orderId: number, actor: string, orderIsDispatchable: SQL): SQL[] {
  const reason = `交運扣庫（訂單 #${orderId}）`;
  return [
    sql`
      INSERT INTO stock_movements (variant_id, kind, delta, on_hand_after, order_id, actor, reason, created_at)
      SELECT line.variant_id, 'dispatch', -line.quantity, variant.on_hand - line.quantity, ${orderId}, ${actor}, ${reason}, ${effectiveNow}
      FROM order_lines line
      JOIN product_variants variant ON variant.id = line.variant_id
      WHERE line.order_id = ${orderId} AND ${orderIsDispatchable}
    `,
    sql`
      UPDATE product_variants
      SET on_hand = on_hand - (SELECT line.quantity FROM order_lines line WHERE line.order_id = ${orderId} AND line.variant_id = product_variants.id)
      WHERE id IN (SELECT variant_id FROM order_lines WHERE order_id = ${orderId}) AND ${orderIsDispatchable}
    `,
  ];
}

export interface StockMovementView {
  id: number;
  variantId: number;
  productName: string;
  /** 變體選項值以「 / 」相連；沒有選項的商品為空字串。 */
  variantLabel: string;
  kind: StockMovementKind;
  delta: number;
  onHandAfter: number;
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
