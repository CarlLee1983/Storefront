/** 不是字串（欄位不存在、檔案）或只有空白，都算留空。 */
function isBlank(value: unknown): boolean {
  return typeof value !== "string" || value.trim() === "";
}

/**
 * 表單值轉數字。空白或非數字轉成 NaN，不在 Web 判斷規則：
 * 由 App 的驗證回報欄位錯誤（Web 不決定什麼輸入合法）。
 */
export function toNumber(value: unknown): number {
  return isBlank(value) ? Number.NaN : Number(value);
}

export function toText(value: unknown): string {
  return typeof value === "string" ? value : "";
}
