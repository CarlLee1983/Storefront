/**
 * 取得要轉交給 App Worker 的 Access JWT。Web 只搬運，不解析、不判斷授權（Holdfast ADR 0007，https://github.com/CarlLee1983/Holdfast/blob/main/docs/adr/0007-admin-behind-cloudflare-access.md）：
 * 有沒有權限完全由 App 驗簽決定。
 *
 * `ACCESS_DEV_JWT`（本機 .dev.vars）只在 `isDev` 為真時才讀；呼叫端傳 `import.meta.env.DEV`，
 * 正式建置時它是常數 false，這條路徑會被整段移除。preview / production 也不得定義這個變數。
 */
export function readAccessJwt(
  request: Request,
  env: { ACCESS_DEV_JWT?: string },
  isDev: boolean,
): string {
  const fromHeader = request.headers.get("Cf-Access-Jwt-Assertion");
  if (fromHeader !== null) return fromHeader;
  return isDev ? (env.ACCESS_DEV_JWT ?? "") : "";
}
