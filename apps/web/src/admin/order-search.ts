import { parseStatusFilter } from "./order-form";

const FILTER_KEYS = ["orderId", "email", "status", "from", "to"] as const;

/** 網址上的查找條件（`?orderId=12&email=…&status=paid&from=2030-03-01&to=2030-03-31`）。 */
export interface OrderSearch {
  orderId: string;
  email: string;
  status: string;
  from: string;
  to: string;
}

/**
 * 網址參數 → 表單回填值：留空與空白一律當作沒填；狀態不是六種之一就視為不篩選。
 * 編號與日期原樣保留，格式由 App 驗證並回報（Web 不決定什麼輸入合法）。
 */
export function readOrderSearch(params: URLSearchParams): OrderSearch {
  const text = (key: string) => (params.get(key) ?? "").trim();
  return { orderId: text("orderId"), email: text("email"), status: parseStatusFilter(text("status") || null) ?? "", from: text("from"), to: text("to") };
}

/** 查找條件 → RPC 輸入：只送有填的欄位；編號轉成數字（非數字為 NaN，由 App 回報欄位錯誤）。 */
export function searchToInput(search: OrderSearch, beforeId?: number) {
  return {
    ...(search.orderId !== "" && { orderId: Number(search.orderId) }),
    ...(search.email !== "" && { email: search.email }),
    ...(search.status !== "" && { status: search.status }),
    ...(search.from !== "" && { from: search.from }),
    ...(search.to !== "" && { to: search.to }),
    ...(beforeId !== undefined && { beforeId }),
  };
}

/** 保留目前查找條件的查詢字串（翻頁與匯出連結用）；`beforeId` 為翻頁游標。 */
export function searchQuery(search: OrderSearch, beforeId?: number): string {
  const params = new URLSearchParams();
  for (const key of FILTER_KEYS) if (search[key] !== "") params.set(key, search[key]);
  if (beforeId !== undefined) params.set("before", String(beforeId));
  return params.toString();
}

/** 網址上的翻頁游標（`?before=`）；不是正整數就當作第一頁。 */
export function readCursor(params: URLSearchParams): number | undefined {
  const value = Number(params.get("before"));
  return Number.isInteger(value) && value > 0 ? value : undefined;
}
