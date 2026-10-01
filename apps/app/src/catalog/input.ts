import { z } from "zod";
import { MAX_SLUG_LENGTH, SLUG_PATTERN } from "../categories/slug";
import { wholeNumber } from "../shared/input";
import { DEFAULT_SORT, MAX_PAGE, MAX_QUERY_LENGTH, PRODUCT_SORTS } from "./listing";

/** 前台商品列表的查詢條件；全部可省略，省略時是「新上架、第 1 頁、不篩選」。 */
export const listProductsInput = z.object({
  category: z.string({ error: "分類代稱必須是文字" }).max(MAX_SLUG_LENGTH).regex(SLUG_PATTERN, "分類代稱格式不正確").optional(),
  inStock: z.boolean({ error: "只看有貨必須是布林值" }).optional(),
  // 先去掉前後空白再檢查長度；空字串視同沒有帶
  q: z.string({ error: "搜尋關鍵字必須是文字" }).trim().max(MAX_QUERY_LENGTH, `搜尋關鍵字不可超過 ${MAX_QUERY_LENGTH} 字`)
    .transform((value) => value === "" ? undefined : value).optional(),
  sort: z.enum(PRODUCT_SORTS, { error: "排序方式不正確" }).default(DEFAULT_SORT),
  page: wholeNumber("頁數").min(1, "頁數至少為 1").max(MAX_PAGE, `頁數不可超過 ${MAX_PAGE}`).default(1),
});

export type ListProductsInput = z.output<typeof listProductsInput>;
