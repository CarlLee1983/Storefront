import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** repo 內的示範清單（#50）。圖片路徑相對於清單所在目錄。 */
export const CATALOG_FILE = resolve(import.meta.dirname, "../../demo/catalog.json");
/** 每件商品最多 8 張商品圖片（CONTEXT.md）。 */
const MAX_PRODUCT_IMAGES = 8;

export interface DemoCategory {
  slug: string;
  name: string;
  blurb: string;
  imageFile: string;
}

export interface DemoProduct {
  name: string;
  description: string;
  /** 分類代稱。 */
  category: string;
  priceTwd: number;
  compareAtPriceTwd: number | null;
  onHand: number;
  featured: boolean;
  /** 依順序上傳，第一張是封面。 */
  imageFiles: string[];
}

export interface DemoCatalog {
  categories: DemoCategory[];
  products: DemoProduct[];
}

export function loadCatalog(file = CATALOG_FILE): DemoCatalog {
  return parseCatalog(JSON.parse(readFileSync(file, "utf8")), dirname(file));
}

/**
 * 驗證清單並把圖片路徑轉成絕對路徑。重跑以分類代稱與商品名稱判斷是否已存在，所以兩者在清單內都必須唯一。
 * 清單是 repo 內的檔案，只檢查 seed 依賴的欄位，不做完整 schema 驗證。
 */
export function parseCatalog(raw: unknown, baseDir: string): DemoCatalog {
  const data = raw as { categories?: unknown; products?: unknown };
  if (!Array.isArray(data?.categories) || !Array.isArray(data?.products)) throw new Error("清單必須有 categories 與 products 陣列");
  const categories = (data.categories as Array<Record<string, any>>).map((c): DemoCategory => ({
    slug: text(c.slug, "分類代稱"),
    name: text(c.name, "分類名稱"),
    blurb: text(c.blurb, "分類說明"),
    imageFile: resolve(baseDir, text(c.image?.file, `分類 ${c.slug} 的圖片`)),
  }));
  assertUnique(categories.map((c) => c.slug), "分類代稱");
  const slugs = new Set(categories.map((c) => c.slug));

  const products = (data.products as Array<Record<string, any>>).map((p): DemoProduct => {
    const name = text(p.name, "商品名稱");
    const priceTwd = positiveInteger(p.priceTwd, `${name} 的售價`);
    const compareAtPriceTwd = p.compareAtPriceTwd == null ? null : positiveInteger(p.compareAtPriceTwd, `${name} 的原價`);
    if (compareAtPriceTwd !== null && compareAtPriceTwd <= priceTwd) throw new Error(`${name} 的原價必須高於售價`);
    if (!slugs.has(p.category)) throw new Error(`${name} 指向不存在的分類：${p.category}`);
    const images = (p.images ?? []) as Array<{ file: unknown }>;
    if (images.length === 0 || images.length > MAX_PRODUCT_IMAGES) throw new Error(`${name} 的商品圖片必須是 1 到 ${MAX_PRODUCT_IMAGES} 張`);
    const onHand = Number(p.onHand);
    if (!Number.isInteger(onHand) || onHand < 0) throw new Error(`${name} 的在庫數必須是非負整數`);
    return {
      name,
      description: text(p.description, `${name} 的說明`),
      category: p.category,
      priceTwd,
      compareAtPriceTwd,
      onHand,
      featured: p.featured === true,
      imageFiles: images.map((image) => resolve(baseDir, text(image.file, `${name} 的圖片`))),
    };
  });
  assertUnique(products.map((p) => p.name), "商品名稱");
  return { categories, products };
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`清單缺少${label}`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new Error(`${label}必須是正整數`);
  return value;
}

function assertUnique(values: string[], label: string) {
  const duplicated = values.filter((value, index) => values.indexOf(value) !== index);
  if (duplicated.length > 0) throw new Error(`清單內有重複的${label}：${[...new Set(duplicated)].join("、")}`);
}
