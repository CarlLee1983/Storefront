/** 導覽列需要的分類欄位。 */
export interface NavCategory {
  slug: string;
  name: string;
  description: string;
}

interface CategoryApp {
  listCategories(): Promise<{ ok: true; data: NavCategory[] }>;
}

/** 分類頁網址 `/categories/:slug` 的代稱；不是分類頁回傳 null。 */
export function categorySlugFromPath(pathname: string): string | null {
  return /^\/categories\/([^/]+)\/?$/.exec(pathname)?.[1] ?? null;
}

/**
 * 導覽列的分類。分類 RPC 失敗時當作沒有分類：導覽列少幾個連結，不該讓整個頁面 500。
 */
export async function loadNavCategories(app: CategoryApp): Promise<NavCategory[]> {
  try {
    return (await app.listCategories()).data;
  } catch (error) {
    console.error(JSON.stringify({ event: "nav_categories_failed", error: error instanceof Error ? error.message : String(error) }));
    return [];
  }
}
