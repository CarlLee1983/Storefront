import { and, asc, eq, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { ProductImage } from "../product-images";
import { categories } from "./schema";

export interface PublicCategory {
  id: number;
  slug: string;
  name: string;
  description: string;
}

/** 分類圖片，形狀同商品封面；沒有圖片為 null。 */
export interface CategoryWithImage extends PublicCategory {
  image: ProductImage | null;
}

export interface AdminCategory extends CategoryWithImage {
  /** 分類內的商品數，不分上架與否。 */
  productCount: number;
  /** 分類內上架中的商品數。 */
  listedProductCount: number;
}

const publicColumns = {
  id: categories.id,
  slug: categories.slug,
  name: categories.name,
  description: categories.description,
};

const listedProductExists = sql`exists (select 1 from products where products.category_id = ${categories}.id and products.listed = 1)`;

const image = sql<ProductImage | null>`(
    select json_object('id', category_image.id, 'variants', json(category_image.variants))
    from category_images category_image where category_image.category_id = ${categories}.id
  )`.mapWith((value: string | null) => value === null ? null : JSON.parse(value) as ProductImage);

const adminColumns = {
  ...publicColumns,
  image,
  productCount: sql<number>`(select count(*) from products where products.category_id = ${categories}.id)`.mapWith(Number),
  listedProductCount: sql<number>`(select count(*) from products where products.category_id = ${categories}.id and products.listed = 1)`.mapWith(Number),
};

/** 後台清單：所有分類依建立順序，帶圖片與商品數。 */
export async function selectCategoriesForAdmin(db: DrizzleD1Database): Promise<AdminCategory[]> {
  return db.select(adminColumns).from(categories).orderBy(asc(categories.id));
}

/** 後台單一分類；不存在回 null。 */
export async function selectCategoryForAdmin(db: DrizzleD1Database, id: number): Promise<AdminCategory | null> {
  const [row] = await db.select(adminColumns).from(categories).where(eq(categories.id, id));
  return row ?? null;
}

/** 前台清單：至少有一件上架商品的分類，依建立順序。 */
export async function selectListedCategories(db: DrizzleD1Database): Promise<CategoryWithImage[]> {
  return db.select({ ...publicColumns, image }).from(categories)
    .where(listedProductExists)
    .orderBy(asc(categories.id));
}

/** 前台依代稱取分類：至少有一件上架商品才算存在，並帶上架商品數（不受列表篩選影響）。 */
export async function selectListedCategoryBySlug(db: DrizzleD1Database, slug: string): Promise<(CategoryWithImage & { listedProductCount: number }) | null> {
  const [row] = await db.select({
    ...publicColumns,
    image,
    listedProductCount: sql<number>`(select count(*) from products where products.category_id = ${categories}.id and products.listed = 1)`.mapWith(Number),
  }).from(categories).where(and(eq(categories.slug, slug), listedProductExists));
  return row ?? null;
}

export async function categoryExists(db: DrizzleD1Database, id: number): Promise<boolean> {
  const [row] = await db.select({ id: categories.id }).from(categories).where(eq(categories.id, id));
  return row !== undefined;
}

/** 建立分類；代稱已存在回 null。 */
export async function insertCategory(
  db: DrizzleD1Database,
  values: { slug: string; name: string; description: string },
): Promise<{ id: number; slug: string } | null> {
  const [row] = await db.insert(categories).values(values).onConflictDoNothing({ target: categories.slug })
    .returning({ id: categories.id, slug: categories.slug });
  return row ?? null;
}

/** 修改名稱與說明；分類不存在回 false。 */
export async function updateCategoryById(
  db: DrizzleD1Database,
  id: number,
  values: { name: string; description: string },
): Promise<boolean> {
  const updated = await db.update(categories).set(values).where(eq(categories.id, id)).returning({ id: categories.id });
  return updated.length > 0;
}
