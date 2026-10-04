/** 單張訂單的明細筆數上限；也讓一次結帳的語句數與綁定參數固定（D1 每次呼叫查詢數有上限）。 */
export const MAX_ORDER_LINES = 20;
/** 單筆明細的數量上限，與 Web 購物車的 `MAX_QUANTITY` 一致。 */
export const MAX_LINE_QUANTITY = 99;
