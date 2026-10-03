/** sitemap 協定每個檔最多 50,000 個網址（且不超過 50MB）；網址只有路徑，遠小於大小上限。 */
export const SITEMAP_URL_LIMIT = 50_000;

/** 固定的公開頁；帳戶、訂單、購物車、結帳、搜尋與後台都不收錄。 */
const STATIC_PATHS = ["/", "/products", "/about", "/faq", "/returns"];

const escapeXml = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

/** 要收錄的路徑：固定頁、有上架商品的分類頁、可收錄的商品頁。特價頁（/sale）內容隨活動變動，不收錄。 */
export function sitemapPaths(categorySlugs: string[], productIds: number[]): string[] {
  return [
    ...STATIC_PATHS,
    ...categorySlugs.map((slug) => `/categories/${encodeURIComponent(slug)}`),
    ...productIds.map((id) => `/products/${id}`),
  ];
}

/** 依上限分檔；沒有任何路徑時也回一個空檔，網址 /sitemap.xml 才不會 404。 */
export function chunkPaths(paths: string[], limit = SITEMAP_URL_LIMIT): string[][] {
  const chunks: string[][] = [];
  for (let start = 0; start < paths.length; start += limit) chunks.push(paths.slice(start, start + limit));
  return chunks.length > 0 ? chunks : [[]];
}

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>\n';

export function urlsetXml(origin: string, paths: string[]): string {
  const entries = paths.map((path) => `<url><loc>${escapeXml(origin + path)}</loc></url>`).join("\n");
  return `${XML_HEADER}<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>\n`;
}

export function sitemapIndexXml(origin: string, count: number): string {
  const entries = Array.from({ length: count }, (_, index) => `<sitemap><loc>${escapeXml(`${origin}/sitemap-${index + 1}.xml`)}</loc></sitemap>`).join("\n");
  return `${XML_HEADER}<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</sitemapindex>\n`;
}

/** robots.txt：擋掉帳戶、訂單、購物車、結帳、後台與 API，並指向 sitemap。 */
export function robotsTxt(origin: string): string {
  return [
    "User-agent: *",
    "Disallow: /admin",
    "Disallow: /account",
    "Disallow: /orders",
    "Disallow: /cart",
    "Disallow: /checkout",
    "Disallow: /login",
    "Disallow: /api/",
    "",
    `Sitemap: ${origin}/sitemap.xml`,
    "",
  ].join("\n");
}
