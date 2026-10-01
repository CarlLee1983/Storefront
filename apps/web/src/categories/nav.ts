/** 導覽列需要的分類欄位。 */
export interface NavCategory {
  slug: string;
  name: string;
  description: string;
}

export interface StorefrontNav {
  categories: NavCategory[];
  /** 有特價商品時，導覽列才顯示「特價」。 */
  hasSale: boolean;
}

interface NavApp {
  getStorefrontNav(): Promise<{ ok: true; data: StorefrontNav }>;
}

/** 分類頁網址 `/categories/:slug` 的代稱；不是分類頁回傳 null。 */
export function categorySlugFromPath(pathname: string): string | null {
  return /^\/categories\/([^/]+)\/?$/.exec(pathname)?.[1] ?? null;
}

/**
 * 導覽列需要的分類與特價入口，一次 RPC 取得。RPC 失敗時當作沒有分類、也沒有特價：導覽列少幾個連結，不該讓整個頁面 500。
 */
export async function loadStorefrontNav(app: NavApp): Promise<StorefrontNav> {
  try {
    return (await app.getStorefrontNav()).data;
  } catch (error) {
    console.error(JSON.stringify({ event: "nav_failed", error: error instanceof Error ? error.message : String(error) }));
    return { categories: [], hasSale: false };
  }
}
