import { and, asc, eq, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { categories } from "./schema";

export interface PublicCategory {
  id: number;
  slug: string;
  name: string;
  description: string;
}

export interface AdminCategory extends PublicCategory {
  /** 分類內的商品數，不分上架與否。 */
  productCount: number;
}

const publicColumns = {
  id: categories.id,
  slug: categories.slug,
  name: categories.name,
  description: categories.description,
};

const listedProductExists = sql`exists (select 1 from products where products.category_id = ${categories}.id and products.listed = 1)`;

/** 後台清單：所有分類依建立順序，帶商品數。 */
export async function selectCategoriesForAdmin(db: DrizzleD1Database): Promise<AdminCategory[]> {
  return db.select({
    ...publicColumns,
    productCount: sql<number>`(select count(*) from products where products.category_id = ${categories}.id)`.mapWith(Number),
  }).from(categories).orderBy(asc(categories.id));
}

/** 前台清單：至少有一件上架商品的分類，依建立順序。 */
export async function selectListedCategories(db: DrizzleD1Database): Promise<PublicCategory[]> {
  return db.select(publicColumns).from(categories)
    .where(listedProductExists)
    .orderBy(asc(categories.id));
}

/** 前台依代稱取分類：至少有一件上架商品才算存在。 */
export async function selectListedCategoryBySlug(db: DrizzleD1Database, slug: string): Promise<PublicCategory | null> {
  const [row] = await db.select(publicColumns).from(categories)
    .where(and(eq(categories.slug, slug), listedProductExists));
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
