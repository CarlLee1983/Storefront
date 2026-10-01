/** 前台商品列表的分頁與排序規則：App 驗證與 Web 網址解析共用同一份（不依賴 zod）。 */

/** 每頁件數；`page` 頁回傳的是第 1 到第 `page` 頁的累計結果。 */
export const PAGE_SIZE = 24;
/** 頁數上限：擋掉亂填的網址，也讓單次查詢的列數有上界（20 × 24 件）。 */
export const MAX_PAGE = 20;

/** 搜尋關鍵字長度上限（去掉前後空白後計算）：App 驗證與 Web 網址解析共用。 */
export const MAX_QUERY_LENGTH = 50;

export const PRODUCT_SORTS = ["new", "price-asc", "price-desc"] as const;
export type ProductSort = (typeof PRODUCT_SORTS)[number];
export const DEFAULT_SORT: ProductSort = "new";
