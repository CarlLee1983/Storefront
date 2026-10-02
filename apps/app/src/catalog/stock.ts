import { sql, type SQL } from "drizzle-orm";
import { batchAtEffectiveNow, effectiveNow } from "../shared/high-water-mark";
import { PAID, PENDING_PAYMENT } from "../orders/schema";
import { fail, ok, type InsufficientStock, type VariantNotFound } from "../shared/result";
import { productVariants } from "./schema";

/**
 * 保留（Reservation）= 待付款與已付款（待出貨）訂單的訂單明細數量（以變體加總），沒有另外的保留表（ADR 0006）：
 * 訂單成立即保留；付款只把待付款保留轉為已付款保留（兩者都在這裡，所以付款前後保留量不變、不重複扣也不釋放）；
 * 逾期、取消離開這兩個狀態而釋放；交運時訂單轉為已出貨，保留消耗，同一個 batch 扣實體在庫（`stock/ledger.ts`）。
 * `variantId` 是外層查詢裡變體編號的 SQL 表達式。
 *
 * 保留只看訂單狀態，不看付款期限：付款期限到 Cron 釋放之間（至多約 1 分鐘）會多保留，
 * 偏保守、只會少賣不會超賣；釋放由 #9 的 Cron 負責。這是與 Holdfast ADR 0003「以時間判定」
 * （https://github.com/CarlLee1983/Holdfast/blob/main/docs/adr/0003-confirm-judged-by-time.md）的刻意偏離，
 * 不要「順手」加上時間條件。
 * 「保留算什麼」只在這裡定義；結帳的條件寫入、庫存調整與所有讀取都用這一個片段。
 */
export function reservedQuantity(variantId: SQL): SQL<number> {
  return sql<number>`(
    SELECT COALESCE(SUM(reserved_line.quantity), 0)
    FROM order_lines reserved_line
    JOIN orders reserved_order ON reserved_order.id = reserved_line.order_id
    WHERE reserved_line.variant_id = ${variantId} AND reserved_order.status IN (${PENDING_PAYMENT}, ${PAID})
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
export function availableExpr(onHand: SQL, variantId: SQL): SQL<number> {
  return sql<number>`(${onHand} - ${reservedQuantity(variantId)})`;
}

/**
 * 庫存調整的防負數條件（Holdfast ADR 0004：單句條件寫入，
 * https://github.com/CarlLee1983/Holdfast/blob/main/docs/adr/0004-oversell-guard-in-single-statement.md）：
 * 調整後的在庫數不可低於有效保留的總和，也就是可售數量不可變負。
 */
function adjustmentKeepsAvailableNonNegative(delta: number) {
  return sql`${availableExpr(sql`${productVariants.onHand} + ${delta}`, sql`${productVariants.id}`)} >= 0`;
}

export interface StockAdjustment {
  variantId: number;
  delta: number;
  reason: string;
  /** 操作人（管理員 email）。 */
  actor: string;
}

/**
 * 以單一 batch 調整在庫數並寫流水，是否拒絕由條件寫入的受影響列數判斷（不先讀再寫，並行時不會互相覆蓋）。
 * 流水與更新用同一個防負數條件，D1 逐句、單寫者執行，所以兩者同成同敗；流水先寫，`on_hand_after` 由調整前的在庫數算出。
 * 沒有任何一列被更新：變體不存在，或條件不成立（會變負數）；變體不能刪除，事後查一次即可區分。
 */
export async function adjustOnHand(
  d1: D1Database,
  { variantId, delta, reason, actor }: StockAdjustment,
  now: number,
): Promise<{ ok: true; data: { onHand: number; available: number } } | VariantNotFound | InsufficientStock> {
  const keepsAvailable = adjustmentKeepsAvailableNonNegative(delta);
  const [, update, read] = await batchAtEffectiveNow(d1, now, [
    sql`
      INSERT INTO stock_movements (variant_id, kind, delta, on_hand_after, order_id, actor, reason, created_at)
      SELECT ${productVariants.id}, 'adjustment', ${delta}, ${productVariants.onHand} + ${delta}, NULL, ${actor}, ${reason}, ${effectiveNow}
      FROM product_variants WHERE ${productVariants.id} = ${variantId} AND ${keepsAvailable}
    `,
    sql`UPDATE product_variants SET on_hand = on_hand + ${delta} WHERE id = ${variantId} AND ${keepsAvailable}`,
    sql`SELECT on_hand AS onHand, ${reservedQuantity(sql`product_variants.id`)} AS reserved FROM product_variants WHERE id = ${variantId}`,
  ]);
  if (update!.meta.changes > 0) {
    const row = read!.results[0] as { onHand: number; reserved: number };
    return ok({ onHand: row.onHand, available: availableQuantity(row.onHand, row.reserved) });
  }
  return fail(read!.results.length > 0 ? "insufficient_stock" : "variant_not_found");
}
