import { and, eq, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { fail, ok, type InsufficientStock, type ProductNotFound } from "../shared/result";
import { products } from "./schema";

/**
 * 可售數量（Available）= 在庫數 − 有效保留的總和。
 * 保留屬於訂單，訂單在 #8 才建立；在那之前沒有保留，可售數量等於在庫數。
 * 「有多少可售」只在這裡計算，#8 加入保留時只改這個模組。
 */
export function availableQuantity(onHand: number): number {
  return onHand;
}

/**
 * 庫存調整的防負數條件（Holdfast ADR 0004：單句條件寫入）：調整後不可讓可售數量變負。
 * 沒有保留時等於「在庫數 + 增減量 ≥ 0」；#8 加入保留時只改這個模組。
 */
function adjustmentKeepsAvailableNonNegative(delta: number) {
  return sql`${products.onHand} + ${delta} >= 0`;
}

/**
 * 以單一條件式 UPDATE 調整在庫數，是否拒絕由受影響列數判斷（不先讀再寫，並行時不會互相覆蓋）。
 * 沒有任何一列被更新：商品不存在，或條件不成立（會變負數）；商品不能刪除，事後查一次即可區分。
 */
export async function adjustOnHand(
  db: DrizzleD1Database,
  id: number,
  delta: number,
): Promise<{ ok: true; data: { onHand: number; available: number } } | ProductNotFound | InsufficientStock> {
  const [row] = await db
    .update(products)
    .set({ onHand: sql`${products.onHand} + ${delta}` })
    .where(and(eq(products.id, id), adjustmentKeepsAvailableNonNegative(delta)))
    .returning({ onHand: products.onHand });
  if (row) return ok({ onHand: row.onHand, available: availableQuantity(row.onHand) });

  const [existing] = await db.select({ id: products.id }).from(products).where(eq(products.id, id));
  return fail(existing ? "insufficient_stock" : "product_not_found");
}
