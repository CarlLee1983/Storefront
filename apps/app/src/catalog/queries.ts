import { asc, eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { products } from "./schema";

export interface ProductSummary {
  id: number;
  name: string;
  description: string;
  /** 單價，新台幣整數元。 */
  priceTwd: number;
}

export interface AdminProductSummary extends ProductSummary {
  listed: boolean;
}

const summaryColumns = {
  id: products.id,
  name: products.name,
  description: products.description,
  priceTwd: products.priceTwd,
};

/** 前台清單：只列上架中的商品，依新增順序。 */
export async function selectListedProducts(db: DrizzleD1Database): Promise<ProductSummary[]> {
  return db.select(summaryColumns).from(products).where(eq(products.listed, true)).orderBy(asc(products.id));
}

/** 後台清單：所有商品（含下架），依新增順序。 */
export async function selectProductsForAdmin(db: DrizzleD1Database): Promise<AdminProductSummary[]> {
  return db
    .select({ ...summaryColumns, listed: products.listed })
    .from(products)
    .orderBy(asc(products.id));
}
