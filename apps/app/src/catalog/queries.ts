import { and, asc, eq, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { productImages } from "../images/schema";
import type { ProductImage } from "../product-images";
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
  /** 依圖片順位挑第一張；下架與舊資料可能沒有圖片。 */
  cover: ProductImage | null;
}

export interface AdminProductSummary extends ProductBase {
  cover: ProductImage | null;
  listed: boolean;
  /** 在庫數（On Hand）。 */
  onHand: number;
  /** 保留數：待付款訂單的訂單明細數量總和。 */
  reserved: number;
  /** 可售數量（Available）= 在庫數 − 保留數。 */
  available: number;
}

export interface AdminProductDetail extends AdminProductSummary {
  images: ProductImage[];
}

const summaryColumns = {
  id: products.id,
  name: products.name,
  description: products.description,
  priceTwd: products.priceTwd,
  onHand: products.onHand,
  reserved: reservedQuantity(sql`${products.id}`).as("reserved"),
};

const cover = sql<ProductImage | null>`(
    select json_object('id', cover_image.id, 'variants', json(cover_image.variants))
    from product_images cover_image where cover_image.product_id = ${products}.id
    order by cover_image.position, cover_image.id limit 1
  )`.mapWith((value: string | null) => value === null ? null : JSON.parse(value) as ProductImage);

const adminColumns = { ...summaryColumns, listed: products.listed, cover };

type AdminRow = Omit<AdminProductSummary, "available">;

function toAdminSummary(row: AdminRow): AdminProductSummary {
  return { ...row, available: availableQuantity(row.onHand, row.reserved) };
}

/** 前台清單：只列上架中的商品，依新增順序。 */
export async function selectListedProducts(db: DrizzleD1Database): Promise<ProductSummary[]> {
  // 同一個查詢帶出封面，按商品＋順位索引找第一張，沒有逐商品 RPC/查詢。

  const rows = await db.select({ ...summaryColumns, cover }).from(products).where(eq(products.listed, true)).orderBy(asc(products.id));
  return rows.map(({ onHand, reserved, ...row }) => ({ ...row, purchasable: availableQuantity(onHand, reserved) > 0 }));
}

/** 後台清單：所有商品（含下架），依新增順序。 */
export async function selectProductsForAdmin(db: DrizzleD1Database): Promise<AdminProductSummary[]> {
  const rows = await db.select(adminColumns).from(products).orderBy(asc(products.id));
  return rows.map(toAdminSummary);
}

/** 單一商品（含下架）；不存在回 null。 */
export async function selectProductForAdmin(db: DrizzleD1Database, id: number): Promise<AdminProductDetail | null> {
  const [row] = await db.select(adminColumns).from(products).where(eq(products.id, id));
  if (!row) return null;
  const images = await db.select({ id: productImages.id, variants: productImages.variants }).from(productImages)
    .where(eq(productImages.productId, id)).orderBy(asc(productImages.position), asc(productImages.id));
  return { ...toAdminSummary(row), images };
}

export interface ProductDetail extends ProductBase {
  purchasable: boolean;
  images: ProductImage[];
}

/** One snapshot: an unlisted product never exposes its details through this public query. */
export async function selectListedProduct(db: DrizzleD1Database, id: number): Promise<ProductDetail | null> {
  const images = sql<ProductImage[]>`(
    select json_group_array(json(ordered.image)) from (
      select json_object('id', image.id, 'variants', json(image.variants)) as image
      from product_images image where image.product_id = ${products}.id
      order by image.position, image.id
    ) ordered
  )`.mapWith((value: string) => JSON.parse(value) as ProductImage[]);
  const [row] = await db.select({ ...summaryColumns, images }).from(products)
    .where(and(eq(products.id, id), eq(products.listed, true)));
  if (!row) return null;
  const { onHand, reserved, ...product } = row;
  return { ...product, purchasable: availableQuantity(onHand, reserved) > 0 };
}
