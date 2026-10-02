import { and, asc, desc, eq, isNull, ne, sql, type SQL } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { categories } from "../categories/schema";
import { productImages } from "../images/schema";
import type { ProductImage } from "../product-images";
import { productVariants, products } from "./schema";
import type { ListProductsInput } from "./input";
import { PAGE_SIZE, type ProductSort } from "./listing";
import type { AdminVariant, ProductSummary, VariantDetail } from "./types";
import { availableExpr, availableQuantity, reservedQuantity } from "./stock";

interface ProductBase {
  id: number;
  name: string;
  description: string;
  /** 預設變體的編號：購物車、結帳與庫存調整都以變體為單位（ADR 0005）。 */
  defaultVariantId: number;
  /** 預設變體的單價，新台幣整數元。 */
  priceTwd: number;
  /** 原價，新台幣整數元；null 表示不是特價商品。 */
  compareAtPriceTwd: number | null;
  /** 尺寸、材質、保養資訊（純文字，空字串表示未提供）。 */
  dimensions: string;
  material: string;
  care: string;
}

export type { AdminVariant, ProductSummary, VariantDetail };

/** 後台商品項目。`defaultVariantId`、價格與庫存欄位（在 ProductBase 與下方）都是預設變體的；全部變體見 `variants`。 */
export interface AdminProductSummary extends ProductBase {
  /** 選項維度名稱，依序；沒有選項為空陣列。 */
  optionNames: string[];
  /** 所有變體（含停賣），預設變體在前，其餘依建立順序。 */
  variants: AdminVariant[];
  cover: ProductImage | null;
  /** 所屬分類；上架中的商品一定有。 */
  category: { id: number; slug: string; name: string } | null;
  listed: boolean;
  /** 是否為精選；下架商品可以保有精選標記。 */
  featured: boolean;
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

/** 商品與其預設變體的 join 條件；多變體商品由後續票擴充，這裡只讀預設變體。 */
const withDefaultVariant = and(eq(productVariants.productId, products.id), eq(productVariants.isDefault, true));

/** 後台用的欄位：商品加上預設變體的價格與庫存。 */
const defaultVariantColumns = {
  id: products.id,
  name: products.name,
  description: products.description,
  dimensions: products.dimensions,
  material: products.material,
  care: products.care,
  // D1 的 batch 以欄位名稱為鍵回傳列，與 products.id 同名會互相覆蓋，所以要取別名
  defaultVariantId: sql<number>`${productVariants.id}`.as("default_variant_id"),
  priceTwd: productVariants.priceTwd,
  compareAtPriceTwd: productVariants.compareAtPriceTwd,
  onHand: productVariants.onHand,
  reserved: reservedQuantity(sql`${productVariants.id}`).as("reserved"),
};

/** 販售中（未停賣）變體的條件；`sv` 是子查詢裡的 `product_variants` 別名。單表 select 會去掉欄位前綴，所以商品編號寫成 `${products}.id`。 */
const activeVariantOfProduct = sql`sv.product_id = ${products}.id AND sv.discontinued_at IS NULL`;

/** 至少一個販售中的變體可售數量大於零；列表的有貨篩選與「可購買」判定共用。 */
const hasPurchasableVariant = sql`exists (
  select 1 from product_variants sv where ${activeVariantOfProduct} and ${availableExpr(sql`sv.on_hand`, sql`sv.id`)} > 0
)`;

/** 前台商品項目的欄位：價格範圍、特價選項與可購買都只看販售中的變體，一個查詢帶出。 */
const listingColumns = {
  id: products.id,
  name: products.name,
  description: products.description,
  defaultVariantId: sql<number>`(select dv.id from product_variants dv where dv.product_id = ${products}.id and dv.is_default = 1)`.as("default_variant_id"),
  hasOptions: sql<boolean>`${products.option1Name} <> ''`.mapWith(Boolean).as("has_options"),
  priceTwd: sql<number | null>`(select min(sv.price_twd) from product_variants sv where ${activeVariantOfProduct})`.as("min_price_twd"),
  maxPriceTwd: sql<number | null>`(select max(sv.price_twd) from product_variants sv where ${activeVariantOfProduct})`.as("max_price_twd"),
  compareAtPriceTwd: sql<number | null>`(select sv.compare_at_price_twd from product_variants sv where ${activeVariantOfProduct} and sv.is_default = 1 and ${products.option1Name} = '')`.as("single_compare_at_price_twd"),
  onSale: sql<boolean>`exists (select 1 from product_variants sv where ${activeVariantOfProduct} and sv.compare_at_price_twd is not null)`.mapWith(Boolean).as("on_sale"),
  purchasable: sql<boolean>`${hasPurchasableVariant}`.mapWith(Boolean).as("purchasable"),
};

const cover = sql<ProductImage | null>`(
    select json_object('id', cover_image.id, 'variants', json(cover_image.variants))
    from product_images cover_image where cover_image.product_id = ${products}.id
    order by cover_image.position, cover_image.id limit 1
  )`.mapWith((value: string | null) => value === null ? null : JSON.parse(value) as ProductImage);

const adminColumns = {
  ...defaultVariantColumns,
  option1Name: products.option1Name,
  option2Name: products.option2Name,
  listed: products.listed,
  featured: sql<boolean>`${products.featuredAt} is not null`.mapWith(Boolean),
  cover,
  categoryId: categories.id,
  categorySlug: categories.slug,
  categoryName: categories.name,
};

type AdminRow = Omit<AdminProductSummary, "available" | "category" | "optionNames" | "variants"> & {
  option1Name: string;
  option2Name: string;
  categoryId: number | null;
  categorySlug: string | null;
  categoryName: string | null;
};

function toAdminSummary({ categoryId, categorySlug, categoryName, option1Name, option2Name, ...row }: AdminRow, variants: AdminVariant[]): AdminProductSummary {
  // left join 的分類欄位在 categoryId 非空時一定有值：category_id 是指向 categories 的外鍵，所以非空斷言成立
  const category = categoryId === null ? null : { id: categoryId, slug: categorySlug!, name: categoryName! };
  return { ...row, optionNames: [option1Name, option2Name].filter((name) => name !== ""), variants, category, available: availableQuantity(row.onHand, row.reserved) };
}

/** 後台的變體列；`productId` 省略時取全部商品的（後台清單用），預設變體排在各商品的最前面。 */
async function selectAdminVariants(db: DrizzleD1Database, productId?: number): Promise<Map<number, AdminVariant[]>> {
  const rows = await db.select({
    id: productVariants.id,
    productId: productVariants.productId,
    isDefault: productVariants.isDefault,
    option1Value: productVariants.option1Value,
    option2Value: productVariants.option2Value,
    priceTwd: productVariants.priceTwd,
    compareAtPriceTwd: productVariants.compareAtPriceTwd,
    onHand: productVariants.onHand,
    reserved: reservedQuantity(sql`${productVariants.id}`).as("reserved"),
    discontinuedAt: productVariants.discontinuedAt,
    imageId: productVariants.imageId,
  }).from(productVariants).where(productId === undefined ? undefined : eq(productVariants.productId, productId))
    .orderBy(desc(productVariants.isDefault), asc(productVariants.id));
  const byProduct = new Map<number, AdminVariant[]>();
  for (const { productId: owner, option1Value, option2Value, discontinuedAt, ...row } of rows) {
    const variant: AdminVariant = {
      ...row,
      optionValues: [option1Value, option2Value].filter((value) => value !== ""),
      available: availableQuantity(row.onHand, row.reserved),
      discontinued: discontinuedAt !== null,
    };
    byProduct.set(owner, [...(byProduct.get(owner) ?? []), variant]);
  }
  return byProduct;
}

/** 價格排序的依據：販售中變體的最低單價；全部停賣時退而用所有變體的最低單價（排序位置不是報價）。 */
const sortPrice = sql`coalesce(
  (select min(sv.price_twd) from product_variants sv where ${activeVariantOfProduct}),
  (select min(av.price_twd) from product_variants av where av.product_id = ${products}.id)
)`;

const listingOrder = {
  "new": [desc(products.listedAt), desc(products.id)],
  "price-asc": [asc(sortPrice), desc(products.id)],
  "price-desc": [desc(sortPrice), desc(products.id)],
} satisfies Record<ProductSort, SQL[]>;

/** LIKE 的萬用字元與跳脫字元本身加上反斜線，讓關鍵字當成一般文字比對。 */
const escapeLike = (value: string) => value.replace(/[\\%_]/g, "\\$&");

/**
 * 名稱或說明含關鍵字（子字串、英文不分大小寫）；關鍵字一律以參數傳入。
 * 兩邊都用 SQLite 的 `lower()`，大小寫規則一致（只處理 ASCII，即英文）。
 */
function keywordMatch(q: string): SQL {
  const pattern = sql`'%' || lower(${escapeLike(q)}) || '%'`;
  return sql`(lower(${products.name}) like ${pattern} escape '\\' or lower(${products.description}) like ${pattern} escape '\\')`;
}

/**
 * 前台列表：上架中的商品，可依分類、可售數量、關鍵字篩選與排序；回傳第 1 到 `page` 頁的累計結果與符合條件的總件數。
 * 排序值相同時一律以 id 遞減，分頁才穩定。分類代稱不存在時 `category_id = NULL` 不成立，自然是空結果。
 */
export async function selectListedProducts(
  db: DrizzleD1Database,
  { category, inStock, onSale, q, sort, page }: ListProductsInput,
): Promise<{ items: ProductSummary[]; total: number }> {
  const where = and(
    eq(products.listed, true),
    category === undefined ? undefined : sql`${products.categoryId} = (select id from categories where slug = ${category})`,
    inStock ? hasPurchasableVariant : undefined,
    q === undefined ? undefined : keywordMatch(q),
    onSale ? sql`exists (select 1 from product_variants sv where ${activeVariantOfProduct} and sv.compare_at_price_twd is not null)` : undefined,
  );
  // 同一個查詢帶出封面，按商品＋順位索引找第一張，沒有逐商品 RPC/查詢。
  // 列表與總件數放同一個 batch（隱含交易），兩者看到同一份資料，hasMore 才不會因並行寫入而矛盾。
  const [rows, [counted]] = await db.batch([
    db.select({ ...listingColumns, cover }).from(products).where(where).orderBy(...listingOrder[sort]).limit(page * PAGE_SIZE),
    db.select({ total: sql<number>`count(*)`.mapWith(Number) }).from(products).where(where),
  ]);
  return { items: rows, total: counted!.total };
}

/** 目前有沒有特價商品（上架中且有原價）；前台導覽列用來決定是否顯示「特價」。 */
export async function existsProductOnSale(db: DrizzleD1Database): Promise<boolean> {
  const [row] = await db.select({ id: products.id }).from(products)
    .where(and(eq(products.listed, true), sql`exists (select 1 from product_variants sv where ${activeVariantOfProduct} and sv.compare_at_price_twd is not null)`)).limit(1);
  return row !== undefined;
}

/** 首頁精選的件數。 */
const FEATURED_LIMIT = 4;

/**
 * 首頁精選：上架中的精選商品依精選時間由新到舊，不足時以上架時間最新、且未入選的上架商品補滿；最多 {@link FEATURED_LIMIT} 件。
 * 一個查詢完成：精選（featured_at 非空）排在補位之前，其餘依上架時間，同值以 id 遞減讓順序穩定，所以不會重複。
 */
export async function selectFeaturedProducts(db: DrizzleD1Database): Promise<ProductSummary[]> {
  return db.select({ ...listingColumns, cover }).from(products).where(eq(products.listed, true))
    .orderBy(sql`${products.featuredAt} is null`, desc(products.featuredAt), desc(products.listedAt), desc(products.id))
    .limit(FEATURED_LIMIT);
}

/** 後台清單：所有商品（含下架），依新增順序。 */
export async function selectProductsForAdmin(db: DrizzleD1Database): Promise<AdminProductSummary[]> {
  const [rows, variants] = await Promise.all([
    db.select(adminColumns).from(products).innerJoin(productVariants, withDefaultVariant).leftJoin(categories, eq(products.categoryId, categories.id)).orderBy(asc(products.id)),
    selectAdminVariants(db),
  ]);
  return rows.map((row) => toAdminSummary(row, variants.get(row.id) ?? []));
}

/** 單一商品（含下架）；不存在回 null。 */
export async function selectProductForAdmin(db: DrizzleD1Database, id: number): Promise<AdminProductDetail | null> {
  const [row] = await db.select(adminColumns).from(products).innerJoin(productVariants, withDefaultVariant).leftJoin(categories, eq(products.categoryId, categories.id)).where(eq(products.id, id));
  if (!row) return null;
  const images = await db.select({ id: productImages.id, variants: productImages.variants }).from(productImages)
    .where(eq(productImages.productId, id)).orderBy(asc(productImages.position), asc(productImages.id));
  return { ...toAdminSummary(row, (await selectAdminVariants(db, id)).get(id) ?? []), images };
}

export interface ProductDetail {
  id: number;
  name: string;
  description: string;
  /** 尺寸、材質、保養資訊（純文字，空字串表示未提供）。 */
  dimensions: string;
  material: string;
  care: string;
  /** 選項維度名稱，依序；沒有選項為空陣列。 */
  optionNames: string[];
  /** 販售中的變體，預設變體在前，其餘依建立順序；全部停賣時為空（不得顯示報價或結帳）。 */
  variants: VariantDetail[];
  /** 至少一個變體可售數量 > 0。 */
  purchasable: boolean;
  images: ProductImage[];
  /** 所屬分類的代稱與名稱；上架中的商品一定有。 */
  category: { slug: string; name: string } | null;
  /** 同分類的其他上架商品，最多 {@link RELATED_LIMIT} 件，依上架時間由新到舊；沒有分類時為空。 */
  related: ProductSummary[];
}

const RELATED_LIMIT = 4;

/** 同分類推薦：不含自己，只含上架中的商品。 */
async function selectRelatedProducts(db: DrizzleD1Database, categoryId: number, excludeId: number): Promise<ProductSummary[]> {
  return db.select({ ...listingColumns, cover }).from(products)
    .where(and(eq(products.listed, true), eq(products.categoryId, categoryId), ne(products.id, excludeId)))
    .orderBy(desc(products.listedAt), desc(products.id)).limit(RELATED_LIMIT);
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
  const [[row], variantRows] = await db.batch([
    db.select({ id: products.id, name: products.name, description: products.description, dimensions: products.dimensions, material: products.material, care: products.care, option1Name: products.option1Name, option2Name: products.option2Name, images, categoryId: products.categoryId,
      // batch 的列以欄位名稱為鍵：分類的 name 會蓋掉商品的 name，所以要取別名
      categorySlug: sql<string | null>`${categories.slug}`.as("category_slug"), categoryName: sql<string | null>`${categories.name}`.as("category_name") })
      .from(products).leftJoin(categories, eq(products.categoryId, categories.id)).where(and(eq(products.id, id), eq(products.listed, true))),
    db.select({
      id: productVariants.id,
      isDefault: productVariants.isDefault,
      option1Value: productVariants.option1Value,
      option2Value: productVariants.option2Value,
      priceTwd: productVariants.priceTwd,
      compareAtPriceTwd: productVariants.compareAtPriceTwd,
      onHand: productVariants.onHand,
      reserved: reservedQuantity(sql`${productVariants.id}`).as("reserved"),
      imageId: productVariants.imageId,
    }).from(productVariants).where(and(eq(productVariants.productId, id), isNull(productVariants.discontinuedAt)))
      .orderBy(desc(productVariants.isDefault), asc(productVariants.id)),
  ]);
  if (!row) return null;
  const { option1Name, option2Name, categoryId, categorySlug, categoryName, ...product } = row;
  const variants = variantRows.map(({ option1Value, option2Value, onHand, reserved, ...variant }): VariantDetail => ({
    ...variant,
    optionValues: [option1Value, option2Value].filter((value) => value !== ""),
    available: Math.max(0, availableQuantity(onHand, reserved)),
  }));
  return {
    ...product,
    optionNames: [option1Name, option2Name].filter((name) => name !== ""),
    variants,
    purchasable: variants.some((variant) => variant.available > 0),
    category: categorySlug === null ? null : { slug: categorySlug, name: categoryName! },
    related: categoryId === null ? [] : await selectRelatedProducts(db, categoryId, id),
  };
}
