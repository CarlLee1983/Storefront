import { toText } from "../shared/form-values";

/** 地址簿表單 → RPC 輸入；不判斷內容是否合法，由 App 驗證。 */
export function addressFormToInput(form: FormData) {
  return { name: toText(form.get("name")), phone: toText(form.get("phone")), address: toText(form.get("address")) };
}

/** 網址或表單上的地址編號；不是正整數就回傳 null（交給 App 回報找不到）。 */
export function parseAddressId(value: unknown): number | null {
  return typeof value === "string" && /^[1-9]\d*$/.test(value) ? Number(value) : null;
}

/** 地址簿操作失敗 → 頁面訊息（固定文案，不回顯 App 原始文字）；`unauthorized` 由頁面另外處理（導向登入）。 */
export function describeAddressFailure(result: { reason: string; fields?: Record<string, string[]> }): string {
  if (result.reason === "invalid_input") {
    const problems = Object.values(result.fields ?? {}).flat();
    return problems.length > 0 ? problems.join("；") : "輸入有誤，請檢查後再試。";
  }
  const messages: Record<string, string> = {
    address_limit_reached: "地址簿已達上限，請先刪除不用的地址再新增。",
    address_not_found: "找不到這筆地址，可能已被刪除，請重新整理頁面。",
  };
  return Object.hasOwn(messages, result.reason) ? messages[result.reason]! : "目前無法完成操作，請稍後再試。";
}
