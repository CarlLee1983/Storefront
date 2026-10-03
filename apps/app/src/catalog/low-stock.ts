import { asc, isNotNull, isNull, and, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { availableExpr, availableQuantity, reservedQuantity } from "./stock";
import { productVariants, products } from "./schema";

/** 低庫存清單的筆數上限：只擋異常大量的設定；超過時依可售少的取前幾筆並回報 `truncated`。 */
export const LOW_STOCK_LIMIT = 200;

export interface LowStockVariant {
  variantId: number;
  productId: number;
  productName: string;
  /** 依商品選項維度的順序；沒有選項的商品為空陣列。 */
  optionValues: string[];
  threshold: number;
  onHand: number;
  unavailable: number;
  reserved: number;
  available: number;
}

/**
 * 低庫存變體：未停賣（下架商品仍列入，下架期間可補貨待重新上架）、已設門檻，且可售數量不高於門檻；可售少的在前。
 * 可售數量與庫存調整、結帳用同一個 `availableExpr`，保留與不可售的商品不會被當成可售而漏提醒；
 * 提醒由當下的可售量推導、不另存狀態，補貨、盤損、訂單與退貨改變可售量後下一次查詢就反映。
 * 門檻部分索引（`product_variants_low_stock_idx`）讓查詢只掃有設門檻的變體。
 */
export async function selectLowStockVariants(db: DrizzleD1Database): Promise<{ items: LowStockVariant[]; truncated: boolean }> {
  const variantRef = sql`${productVariants.id}`;
  const available = sql<number>`${availableExpr(sql`${productVariants.onHand}`, variantRef)}`;
  const rows = await db
    .select({
      variantId: productVariants.id,
      productId: productVariants.productId,
      productName: products.name,
      option1Value: productVariants.option1Value,
      option2Value: productVariants.option2Value,
      threshold: sql<number>`${productVariants.lowStockThreshold}`,
      onHand: productVariants.onHand,
      unavailable: productVariants.unavailable,
      reserved: reservedQuantity(variantRef).as("reserved"),
    })
    .from(productVariants)
    .innerJoin(products, sql`${products.id} = ${productVariants.productId}`)
    .where(and(
      isNotNull(productVariants.lowStockThreshold),
      isNull(productVariants.discontinuedAt),
      sql`${available} <= ${productVariants.lowStockThreshold}`,
    ))
    .orderBy(asc(available), asc(productVariants.id))
    .limit(LOW_STOCK_LIMIT + 1);
  const items = rows.slice(0, LOW_STOCK_LIMIT).map(({ option1Value, option2Value, ...row }) => ({
    ...row,
    optionValues: [option1Value, option2Value].filter((value) => value !== ""),
    available: availableQuantity(row.onHand, row.unavailable, row.reserved),
  }));
  return { items, truncated: rows.length > LOW_STOCK_LIMIT };
}
