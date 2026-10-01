// PROTOTYPE — 前台改版三頁草稿用的假資料，丟棄式分支專用，勿併入 main。
export type ArtKind = "chair" | "lamp" | "table" | "shelf" | "vase" | "sofa" | "stool" | "bed" | "mirror" | "bowl";

export interface Product {
  id: number;
  name: string;
  category: string;
  priceTwd: number;
  compareAtTwd?: number;
  available: number;
  art: ArtKind;
  tone: string;
  newDays: number;
}

export interface Category {
  slug: string;
  name: string;
  blurb: string;
  art: ArtKind;
}

export const CATEGORIES: Category[] = [
  { slug: "living", name: "客廳", blurb: "沙發、邊几、收納", art: "sofa" },
  { slug: "dining", name: "餐廳", blurb: "餐椅、餐桌、器皿", art: "chair" },
  { slug: "bedroom", name: "臥室", blurb: "床架、床邊几、寢具", art: "bed" },
  { slug: "workspace", name: "工作區", blurb: "書桌、檯燈、整理", art: "lamp" },
];

export const PRODUCTS: Product[] = [
  { id: 1, name: "Luma 弧形單椅", category: "living", priceTwd: 21800, available: 6, art: "chair", tone: "#8a5a3c", newDays: 3 },
  { id: 2, name: "Astra 半球檯燈", category: "workspace", priceTwd: 3980, compareAtTwd: 4980, available: 12, art: "lamp", tone: "#1c1c1c", newDays: 20 },
  { id: 3, name: "Nora 圓形餐桌", category: "dining", priceTwd: 26800, available: 2, art: "table", tone: "#a0704a", newDays: 40 },
  { id: 4, name: "Frame 開放書架", category: "living", priceTwd: 15800, available: 0, art: "shelf", tone: "#2a2a2a", newDays: 60 },
  { id: 5, name: "Stone 陶土花器", category: "living", priceTwd: 1680, compareAtTwd: 2280, available: 30, art: "vase", tone: "#cfc8bc", newDays: 1 },
  { id: 6, name: "Fold 三人座沙發", category: "living", priceTwd: 48800, available: 3, art: "sofa", tone: "#b9b7b2", newDays: 15 },
  { id: 7, name: "Peg 圓凳", category: "living", priceTwd: 3280, available: 18, art: "stool", tone: "#b07a50", newDays: 8 },
  { id: 8, name: "Halo 圓鏡", category: "living", priceTwd: 5800, compareAtTwd: 7200, available: 5, art: "mirror", tone: "#9a9a9a", newDays: 30 },
  { id: 9, name: "Ash 木質淺缽", category: "living", priceTwd: 980, available: 0, art: "bowl", tone: "#c09468", newDays: 90 },
  { id: 10, name: "Kei 低背邊椅", category: "living", priceTwd: 12800, available: 9, art: "chair", tone: "#3d3d3d", newDays: 12 },
  { id: 11, name: "Arc 落地燈", category: "living", priceTwd: 8900, compareAtTwd: 10800, available: 4, art: "lamp", tone: "#c4321c", newDays: 25 },
  { id: 12, name: "Slab 茶几", category: "living", priceTwd: 9800, available: 7, art: "table", tone: "#d8d2c6", newDays: 50 },
  { id: 13, name: "Twin 收納櫃", category: "living", priceTwd: 18800, available: 2, art: "shelf", tone: "#8a5a3c", newDays: 70 },
  { id: 14, name: "Dune 長形花器", category: "living", priceTwd: 2280, available: 14, art: "vase", tone: "#4a4a4a", newDays: 5 },
];

export const PAGE_SIZE = 8; // 正式版是 24；假資料少，改小才看得到「載入更多」

export type Sort = "new" | "price-asc" | "price-desc";
export const SORTS: { key: Sort; label: string }[] = [
  { key: "new", label: "新上架" },
  { key: "price-asc", label: "價格低到高" },
  { key: "price-desc", label: "價格高到低" },
];

export interface ListingQuery {
  sort: Sort;
  inStock: boolean;
  onSale: boolean;
  page: number;
}

export function readListing(url: URL): ListingQuery {
  const sort = (SORTS.find(s => s.key === url.searchParams.get("sort"))?.key ?? "new") as Sort;
  const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
  return { sort, inStock: url.searchParams.get("instock") === "1", onSale: url.searchParams.get("sale") === "1", page };
}

export function listing(category: string, q: ListingQuery) {
  const all = PRODUCTS.filter(p => p.category === category)
    .filter(p => !q.inStock || p.available > 0)
    .filter(p => !q.onSale || p.compareAtTwd !== undefined)
    .toSorted((a, b) => q.sort === "new" ? a.newDays - b.newDays : q.sort === "price-asc" ? a.priceTwd - b.priceTwd : b.priceTwd - a.priceTwd);
  const shown = all.slice(0, q.page * PAGE_SIZE);
  return { total: all.length, shown, hasMore: shown.length < all.length };
}

/** 保留目前的查詢參數，只改其中幾個，給排序／篩選／載入更多的連結用。 */
export function withParams(url: URL, changes: Record<string, string | null>): string {
  const next = new URL(url);
  for (const [k, v] of Object.entries(changes)) {
    if (v === null) next.searchParams.delete(k);
    else next.searchParams.set(k, v);
  }
  return `${next.pathname}${next.search}`;
}

export const twd = (n: number) => `NT$ ${n.toLocaleString("en-US")}`;
export const discountPct = (p: Product) => p.compareAtTwd ? Math.round((1 - p.priceTwd / p.compareAtTwd) * 100) : 0;

export const DETAIL = PRODUCTS[1]!; // Astra 半球檯燈：特價、有庫存
export const DETAIL_GALLERY: { art: ArtKind; tone: string; bg: string }[] = [
  { art: "lamp", tone: "#1c1c1c", bg: "#ececea" },
  { art: "lamp", tone: "#1c1c1c", bg: "#e2ddd4" },
  { art: "lamp", tone: "#c4321c", bg: "#ececea" },
];
export const DETAIL_COPY = "粉體烤漆鋼製燈罩搭配實心鑄鐵底座，燈罩下緣收出柔和的漫射光，適合書桌與床邊。附 E27 燈座與 1.8 公尺布線。";
export const DETAIL_SPECS: [string, string][] = [
  ["尺寸", "Ø 28 × H 42 cm"],
  ["材質", "鋼、鑄鐵"],
  ["光源", "E27，建議 8W LED"],
  ["產地", "台灣"],
];
export const RELATED = [PRODUCTS[0]!, PRODUCTS[4]!, PRODUCTS[7]!, PRODUCTS[10]!];

export const CART: { product: Product; quantity: number }[] = [
  { product: PRODUCTS[1]!, quantity: 1 },
  { product: PRODUCTS[4]!, quantity: 2 },
  { product: PRODUCTS[6]!, quantity: 1 },
];
export const cartTotal = () => CART.reduce((sum, l) => sum + l.product.priceTwd * l.quantity, 0);
