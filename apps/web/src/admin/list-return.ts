type ListKind = "products" | "orders";

const LIST_KEYS = {
  products: ["q", "status", "category", "page"],
  orders: ["orderId", "email", "status", "from", "to", "before"],
} satisfies Record<ListKind, string[]>;

/** 只攜帶列表查找與位置，不將操作提示或其他頁面的參數帶進返回狀態。 */
export function adminListHref(kind: ListKind, params: URLSearchParams): string {
  const query = new URLSearchParams();
  for (const key of LIST_KEYS[kind]) {
    const value = params.get(key);
    if (value) query.set(key, value);
  }
  return `/admin/${kind}${query.size ? `?${query}` : ""}`;
}

/** 返回只能是所屬列表的原始相對路徑；先驗路徑，避免 URL 正規化接受別的目的地。 */
export function readAdminListReturn(raw: string | null, kind: ListKind): string {
  const fallback = `/admin/${kind}`;
  if (!raw || (raw !== fallback && !raw.startsWith(`${fallback}?`))) return fallback;
  if (/[\\#\u0000-\u001f\u007f]/.test(raw) || /%(?![\da-f]{2})/i.test(raw)) return fallback;
  const params = new URLSearchParams(raw.slice(fallback.length + 1));
  const seen = new Set<string>();
  for (const key of params.keys()) {
    if (!LIST_KEYS[kind].includes(key) || seen.has(key)) return fallback;
    seen.add(key);
  }
  return adminListHref(kind, params);
}

/** href 是程式建立的站內連結；returnTo 必須先經 readAdminListReturn 或 adminListHref。 */
export function withListReturn(href: string, returnTo: string): string {
  if (!returnTo.includes("?")) return href;
  const url = new URL(href, "https://storefront.invalid");
  url.searchParams.set("returnTo", returnTo);
  return `${url.pathname}${url.search}${url.hash}`;
}
