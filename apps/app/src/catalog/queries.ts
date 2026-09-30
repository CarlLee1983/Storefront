import { asc, eq, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { products } from "./schema";
import { availableQuantity, reservedQuantity } from "./stock";

interface ProductBase {
  id: number;
  name: string;
  description: string;
  /** 單價，新台幣整數元。 */
  priceTwd: number;
}

export interface ProductSummary extends ProductBase {
  /** 是否還能購買（可售數量 > 0）；前台不需要知道確切數量。 */
  purchasable: boolean;
}

export interface AdminProductSummary extends ProductBase {
  listed: boolean;
  /** 在庫數（On Hand）。 */
  onHand: number;
  /** 保留數：待付款訂單的訂單明細數量總和。 */
  reserved: number;
  /** 可售數量（Available）= 在庫數 − 保留數。 */
  available: number;
}

const summaryColumns = {
  id: products.id,
  name: products.name,
  description: products.description,
  priceTwd: products.priceTwd,
  onHand: products.onHand,
  reserved: reservedQuantity(sql`${products.id}`).as("reserved"),
};

const adminColumns = { ...summaryColumns, listed: products.listed };

type AdminRow = Omit<AdminProductSummary, "available">;

function toAdminSummary(row: AdminRow): AdminProductSummary {
  return { ...row, available: availableQuantity(row.onHand, row.reserved) };
}

/** 前台清單：只列上架中的商品，依新增順序。 */
export async function selectListedProducts(db: DrizzleD1Database): Promise<ProductSummary[]> {
  const rows = await db.select(summaryColumns).from(products).where(eq(products.listed, true)).orderBy(asc(products.id));
  return rows.map(({ onHand, reserved, ...row }) => ({ ...row, purchasable: availableQuantity(onHand, reserved) > 0 }));
}

/** 後台清單：所有商品（含下架），依新增順序。 */
export async function selectProductsForAdmin(db: DrizzleD1Database): Promise<AdminProductSummary[]> {
  const rows = await db.select(adminColumns).from(products).orderBy(asc(products.id));
  return rows.map(toAdminSummary);
}

/** 單一商品（含下架）；不存在回 null。 */
export async function selectProductForAdmin(db: DrizzleD1Database, id: number): Promise<AdminProductSummary | null> {
  const [row] = await db.select(adminColumns).from(products).where(eq(products.id, id));
  return row ? toAdminSummary(row) : null;
}
