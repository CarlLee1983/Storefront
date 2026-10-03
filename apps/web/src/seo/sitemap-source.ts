import { chunkPaths, sitemapPaths } from "./sitemap";

interface SitemapSource {
  listCategories(): Promise<{ ok: true; data: { slug: string }[] } | { ok: false }>;
  listSitemapProductIds(): Promise<{ ok: true; data: number[] } | { ok: false }>;
}

/** 讀公開的分類與商品編號，分檔後回傳各檔的路徑；任一讀取失敗就丟錯，讓端點回 5xx 而不是給搜尋引擎一份殘缺的 sitemap。 */
export async function loadSitemapChunks(app: SitemapSource): Promise<string[][]> {
  const [categories, productIds] = await Promise.all([app.listCategories(), app.listSitemapProductIds()]);
  if (!categories.ok || !productIds.ok) throw new Error("sitemap source unavailable");
  return chunkPaths(sitemapPaths(categories.data.map((category) => category.slug), productIds.data));
}
