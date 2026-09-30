import { and, eq, sql, type SQL } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { PENDING_PAYMENT } from "../orders/schema";
import { fail, ok, type InsufficientStock, type ProductNotFound } from "../shared/result";
import { products } from "./schema";

/**
 * 保留（Reservation）= 待付款訂單的訂單明細數量，沒有另外的保留表：訂單離開待付款（逾期、取消、付款）
 * 明細就不再被算進來，保留隨之釋放或轉為正式扣除。`productId` 是外層查詢裡商品編號的 SQL 表達式。
 *
 * 保留只看訂單狀態（待付款），不看付款期限：付款期限到 Cron 釋放之間（至多約 1 分鐘）會多保留，
 * 偏保守、只會少賣不會超賣；釋放由 #9 的 Cron 負責。這是與 Holdfast ADR 0003「以時間判定」
 * （https://github.com/CarlLee1983/Holdfast/blob/main/docs/adr/0003-confirm-judged-by-time.md）的刻意偏離，
 * 不要「順手」加上時間條件。
 * 「保留算什麼」只在這裡定義；結帳的條件寫入、庫存調整與所有讀取都用這一個片段。
 */
export function reservedQuantity(productId: SQL): SQL<number> {
  return sql<number>`(
    SELECT COALESCE(SUM(reserved_line.quantity), 0)
    FROM order_lines reserved_line
    JOIN orders reserved_order ON reserved_order.id = reserved_line.order_id
    WHERE reserved_line.product_id = ${productId} AND reserved_order.status = ${PENDING_PAYMENT}
  )`;
}

/**
 * 可售數量（Available）= 在庫數 − 有效保留的總和。
 * 「有多少可售」只在這個模組計算：SQL 端用 `availableExpr`（條件寫入用），讀出來的列用這個函式。
 */
export function availableQuantity(onHand: number, reserved: number): number {
  return onHand - reserved;
}

/** `availableQuantity` 的 SQL 版本，給條件寫入使用。 */
export function availableExpr(onHand: SQL, productId: SQL): SQL<number> {
  return sql<number>`(${onHand} - ${reservedQuantity(productId)})`;
}

/**
 * 庫存調整的防負數條件（Holdfast ADR 0004：單句條件寫入，
 * https://github.com/CarlLee1983/Holdfast/blob/main/docs/adr/0004-oversell-guard-in-single-statement.md）：
 * 調整後的在庫數不可低於有效保留的總和，也就是可售數量不可變負。
 */
function adjustmentKeepsAvailableNonNegative(delta: number) {
  return sql`${availableExpr(sql`${products.onHand} + ${delta}`, sql`${products.id}`)} >= 0`;
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
    .returning({ onHand: products.onHand, reserved: reservedQuantity(sql`${products.id}`) });
  if (row) return ok({ onHand: row.onHand, available: availableQuantity(row.onHand, row.reserved) });

  const [existing] = await db.select({ id: products.id }).from(products).where(eq(products.id, id));
  return fail(existing ? "insufficient_stock" : "product_not_found");
}
