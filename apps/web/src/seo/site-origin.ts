/** 正式網站 origin：優先用環境設定的 `SITE_ORIGIN`（正式網域），沒設（本機）時用請求自己的 origin，與頁面的 canonical 一致。 */
export function siteOrigin(configured: string | undefined, requestUrl: URL): string {
  const value = configured?.trim();
  return value ? new URL(value).origin : requestUrl.origin;
}
