import { sql } from "drizzle-orm";
import { productVariants } from "../catalog/schema";
import { awaitingInspectionQuantity } from "../returns/queries";
import { batchAtEffectiveNow, effectiveNow } from "../shared/high-water-mark";
import { fail, ok, type InsufficientUnavailable, type VariantNotFound } from "../shared/result";

export interface Scrap {
  variantId: number;
  quantity: number;
  reason: string;
  /** 操作人（管理員 email）。 */
  actor: string;
}

/**
 * 報廢隔離的損壞品（ADR 0006）：商品移出倉庫，同時減少實體在庫與不可售數量，可售數量不變，原因寫進庫存流水。
 * 只能報廢「不可售 − 待檢」：已收回但尚未檢查的退貨還不知道是良品還是損壞，不能報廢（見 `awaitingInspectionQuantity`）。
 * 以單一 batch 流水與更新共用同一個條件（同 `adjustOnHand`），D1 逐句、單寫者執行，所以兩者同成同敗，並行的報廢與檢查不會互相超量。
 * 沒有任何一列被更新：變體不存在，或數量超過可報廢的損壞品；變體不能刪除，事後查一次即可區分。
 */
export async function scrapUnavailable(
  d1: D1Database,
  { variantId, quantity, reason, actor }: Scrap,
  now: number,
): Promise<{ ok: true; data: { onHand: number; unavailable: number } } | VariantNotFound | InsufficientUnavailable> {
  const scrappable = sql`${productVariants.unavailable} - ${awaitingInspectionQuantity(sql`${productVariants.id}`)} >= ${quantity}`;
  const [, update, read] = await batchAtEffectiveNow(d1, now, [
    sql`
      INSERT INTO stock_movements (variant_id, kind, delta, on_hand_after, unavailable_delta, unavailable_after, order_id, actor, reason, created_at)
      SELECT ${productVariants.id}, 'scrap', ${-quantity}, ${productVariants.onHand} - ${quantity}, ${-quantity}, ${productVariants.unavailable} - ${quantity}, NULL, ${actor}, ${reason}, ${effectiveNow}
      FROM product_variants WHERE ${productVariants.id} = ${variantId} AND ${scrappable}
    `,
    sql`UPDATE product_variants SET on_hand = on_hand - ${quantity}, unavailable = unavailable - ${quantity} WHERE id = ${variantId} AND ${scrappable}`,
    sql`SELECT on_hand AS onHand, unavailable FROM product_variants WHERE id = ${variantId}`,
  ]);
  if (update!.meta.changes > 0) return ok(read!.results[0] as { onHand: number; unavailable: number });
  return fail(read!.results.length > 0 ? "insufficient_unavailable" : "variant_not_found");
}
