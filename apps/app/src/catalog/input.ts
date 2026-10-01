import { z } from "zod";
import { MAX_SLUG_LENGTH, SLUG_PATTERN } from "../categories/slug";
import { wholeNumber } from "../shared/input";

/** 每頁件數；`page` 頁回傳的是第 1 到第 `page` 頁的累計結果。 */
export const PAGE_SIZE = 24;
/** 頁數上限：擋掉亂填的網址，也讓單次查詢的列數有上界（20 × 24 件）。 */
export const MAX_PAGE = 20;

export const PRODUCT_SORTS = ["new", "price-asc", "price-desc"] as const;
export type ProductSort = (typeof PRODUCT_SORTS)[number];

/** 前台商品列表的查詢條件；全部可省略，省略時是「新上架、第 1 頁、不篩選」。 */
export const listProductsInput = z.object({
  category: z.string({ error: "分類代稱必須是文字" }).max(MAX_SLUG_LENGTH).regex(SLUG_PATTERN, "分類代稱格式不正確").optional(),
  inStock: z.boolean({ error: "只看有貨必須是布林值" }).optional(),
  sort: z.enum(PRODUCT_SORTS, { error: "排序方式不正確" }).default("new"),
  page: wholeNumber("頁數").min(1, "頁數至少為 1").max(MAX_PAGE, `頁數不可超過 ${MAX_PAGE}`).default(1),
});

export type ListProductsInput = z.output<typeof listProductsInput>;
