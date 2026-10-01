import { and, asc, desc, eq, sql, type SQL } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { categories } from "../categories/schema";
import { productImages } from "../images/schema";
import type { ProductImage } from "../product-images";
import { products } from "./schema";
import type { ListProductsInput } from "./input";
import { PAGE_SIZE, type ProductSort } from "./listing";
import { availableExpr, availableQuantity, reservedQuantity } from "./stock";

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
  /** 所屬分類；上架中的商品一定有。 */
  category: { id: number; slug: string; name: string } | null;
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

const adminColumns = {
  ...summaryColumns,
  listed: products.listed,
  cover,
  categoryId: categories.id,
  categorySlug: categories.slug,
  categoryName: categories.name,
};

type AdminRow = Omit<AdminProductSummary, "available" | "category"> & {
  categoryId: number | null;
  categorySlug: string | null;
  categoryName: string | null;
};

function toAdminSummary({ categoryId, categorySlug, categoryName, ...row }: AdminRow): AdminProductSummary {
  // left join 的分類欄位在 categoryId 非空時一定有值：category_id 是指向 categories 的外鍵，所以非空斷言成立
  const category = categoryId === null ? null : { id: categoryId, slug: categorySlug!, name: categoryName! };
  return { ...row, category, available: availableQuantity(row.onHand, row.reserved) };
}

/** 前台商品項目：只含上架中的商品，帶封面與是否可購買。 */
function toSummary({ onHand, reserved, ...row }: Omit<ProductSummary, "purchasable"> & { onHand: number; reserved: number }): ProductSummary {
  return { ...row, purchasable: availableQuantity(onHand, reserved) > 0 };
}

const listingOrder = {
  "new": [desc(products.listedAt), desc(products.id)],
  "price-asc": [asc(products.priceTwd), desc(products.id)],
  "price-desc": [desc(products.priceTwd), desc(products.id)],
} satisfies Record<ProductSort, SQL[]>;

/**
 * 前台列表：上架中的商品，可依分類、可售數量篩選與排序；回傳第 1 到 `page` 頁的累計結果與符合條件的總件數。
 * 排序值相同時一律以 id 遞減，分頁才穩定。分類代稱不存在時 `category_id = NULL` 不成立，自然是空結果。
 */
export async function selectListedProducts(
  db: DrizzleD1Database,
  { category, inStock, sort, page }: ListProductsInput,
): Promise<{ items: ProductSummary[]; total: number }> {
  const where = and(
    eq(products.listed, true),
    category === undefined ? undefined : sql`${products.categoryId} = (select id from categories where slug = ${category})`,
    inStock ? sql`${availableExpr(sql`${products.onHand}`, sql`${products.id}`)} > 0` : undefined,
  );
  // 同一個查詢帶出封面，按商品＋順位索引找第一張，沒有逐商品 RPC/查詢。
  // 列表與總件數放同一個 batch（隱含交易），兩者看到同一份資料，hasMore 才不會因並行寫入而矛盾。
  const [rows, [counted]] = await db.batch([
    db.select({ ...summaryColumns, cover }).from(products).where(where).orderBy(...listingOrder[sort]).limit(page * PAGE_SIZE),
    db.select({ total: sql<number>`count(*)`.mapWith(Number) }).from(products).where(where),
  ]);
  return { items: rows.map(toSummary), total: counted!.total };
}

/** 後台清單：所有商品（含下架），依新增順序。 */
export async function selectProductsForAdmin(db: DrizzleD1Database): Promise<AdminProductSummary[]> {
  const rows = await db.select(adminColumns).from(products).leftJoin(categories, eq(products.categoryId, categories.id)).orderBy(asc(products.id));
  return rows.map(toAdminSummary);
}

/** 單一商品（含下架）；不存在回 null。 */
export async function selectProductForAdmin(db: DrizzleD1Database, id: number): Promise<AdminProductDetail | null> {
  const [row] = await db.select(adminColumns).from(products).leftJoin(categories, eq(products.categoryId, categories.id)).where(eq(products.id, id));
  if (!row) return null;
  const images = await db.select({ id: productImages.id, variants: productImages.variants }).from(productImages)
    .where(eq(productImages.productId, id)).orderBy(asc(productImages.position), asc(productImages.id));
  return { ...toAdminSummary(row), images };
}

export interface ProductDetail extends ProductBase {
  purchasable: boolean;
  images: ProductImage[];
  /** 所屬分類的代稱與名稱；上架中的商品一定有。 */
  category: { slug: string; name: string } | null;
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
  const [row] = await db.select({ ...summaryColumns, images, categorySlug: categories.slug, categoryName: categories.name }).from(products)
    .leftJoin(categories, eq(products.categoryId, categories.id))
    .where(and(eq(products.id, id), eq(products.listed, true)));
  if (!row) return null;
  const { onHand, reserved, categorySlug, categoryName, ...product } = row;
  return {
    ...product,
    purchasable: availableQuantity(onHand, reserved) > 0,
    category: categorySlug === null ? null : { slug: categorySlug, name: categoryName! },
  };
}
