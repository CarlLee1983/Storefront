import { eq, inArray, sql, type SQL } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { productVariants } from "../catalog/schema";
import { shippingRates } from "./schema";
import { computeShippingFees, type DeliveryType, type ShippingFees, type ShippingRates } from "./types";

/** 現行費率；遷移保證每類型都有一列。 */
export async function selectShippingRates(db: DrizzleD1Database): Promise<ShippingRates> {
  const rows = await db.select().from(shippingRates);
  const rates = { standard: 0, large: 0 };
  for (const row of rows) rates[row.deliveryType as DeliveryType] = row.feeTwd;
  return rates;
}

/** 調整某類型的費率（只影響之後的訂單）；回傳調整後的費率。 */
export async function updateShippingRate(db: DrizzleD1Database, deliveryType: DeliveryType, feeTwd: number): Promise<ShippingRates> {
  await db.update(shippingRates).set({ feeTwd }).where(eq(shippingRates.deliveryType, deliveryType));
  return selectShippingRates(db);
}

/** 這些變體目前的配送類型；不存在的變體不會出現在結果裡。 */
export async function selectVariantDeliveryTypes(db: DrizzleD1Database, variantIds: number[]): Promise<{ variantId: number; deliveryType: DeliveryType }[]> {
  if (variantIds.length === 0) return [];
  return db
    .select({ variantId: productVariants.id, deliveryType: productVariants.deliveryType })
    .from(productVariants)
    .where(inArray(productVariants.id, variantIds));
}

/** 這些變體現在結帳要收的運費（讀當下的類型與費率）。 */
export async function selectShippingFees(db: DrizzleD1Database, variantIds: number[]): Promise<ShippingFees> {
  const [types, rates] = await Promise.all([selectVariantDeliveryTypes(db, variantIds), selectShippingRates(db)]);
  return computeShippingFees(types.map((row) => row.deliveryType), rates);
}

/**
 * 結帳 batch 內某類型的運費：明細（`linesJson`）含該類型的變體就收一次現行費率，否則 0。
 * 與寫訂單明細的語句在同一個 batch 讀同一份資料，所以訂單的運費、明細的類型快照與金額彼此一致。
 */
export function shippingFeeSql(linesJson: string, deliveryType: DeliveryType): SQL {
  return sql`coalesce((
    SELECT rate.fee_twd FROM shipping_rates rate
    WHERE rate.delivery_type = ${deliveryType}
      AND EXISTS (
        SELECT 1 FROM json_each(${linesJson}) wanted
        JOIN product_variants fee_variant ON fee_variant.id = json_extract(wanted.value, '$.variantId')
        WHERE fee_variant.delivery_type = ${deliveryType}
      )
  ), 0)`;
}
