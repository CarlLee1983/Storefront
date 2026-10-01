/** 列表網址上的排序、篩選與頁數；排序與頁數的合法值與 App 的 `listProducts` 一致，是否合法最終由 App 驗證。 */
export type ListingSort = "new" | "price-asc" | "price-desc";

export interface ListingState {
  sort: ListingSort;
  inStock: boolean;
  page: number;
}

const SORTS: readonly ListingSort[] = ["new", "price-asc", "price-desc"];
const DEFAULT_SORT: ListingSort = "new";
/** 與 App 的頁數上限相同；超過的網址視為非法，回第 1 頁。 */
export const MAX_PAGE = 20;

/** 從網址參數解析列表狀態；任何非法值都回到預設，不拋錯（網址是使用者可以隨意改的）。 */
export function parseListingParams(params: URLSearchParams): ListingState {
  const sort = params.get("sort");
  const page = params.get("page");
  const pageNumber = page !== null && /^\d+$/.test(page) ? Number(page) : 1;
  return {
    sort: SORTS.find((candidate) => candidate === sort) ?? DEFAULT_SORT,
    inStock: params.get("instock") === "1",
    page: pageNumber >= 1 && pageNumber <= MAX_PAGE ? pageNumber : 1,
  };
}

/**
 * 產生列表連結：以目前網址的參數為底，套用 `change`。其他參數原樣保留；預設值（新上架、未篩選、第 1 頁）不寫進網址。
 * 改排序或篩選時頁數重置為 1（`change` 沒帶 `page` 就不寫頁數），只改 `page` 則保留排序與篩選。
 */
export function listingHref(pathname: string, current: URLSearchParams, change: Partial<ListingState>): string {
  const state = { ...parseListingParams(current), ...change };
  const page = change.page ?? 1;
  const next = new URLSearchParams(current);
  for (const key of ["sort", "instock", "page"]) next.delete(key);
  if (state.sort !== DEFAULT_SORT) next.set("sort", state.sort);
  if (state.inStock) next.set("instock", "1");
  if (page > 1) next.set("page", String(page));
  const query = next.toString();
  return query === "" ? pathname : `${pathname}?${query}`;
}
