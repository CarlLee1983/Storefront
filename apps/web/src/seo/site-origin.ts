/** sitemap、robots.txt 與結構化資料用的網站 origin：有設定 `SITE_ORIGIN` 就用它，沒設（本機）時用請求自己的 origin。頁面 canonical 另由 Layout 取請求 origin，兩者在部署環境須是同一個網域。 */
export function siteOrigin(configured: string | undefined, requestUrl: URL): string {
  const value = configured?.trim();
  return value ? new URL(value).origin : requestUrl.origin;
}
