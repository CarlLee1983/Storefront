/** 所有 RPC 方法的回傳形狀：業務上的拒絕用具名 reason 表達，不丟例外。 */
export type Result<T, Reason extends string> =
  | { ok: true; data: T }
  | { ok: false; reason: Reason };

export const ok = <T>(data: T): { ok: true; data: T } => ({ ok: true, data });

export const fail = <Reason extends string>(
  reason: Reason,
): { ok: false; reason: Reason } => ({ ok: false, reason });

/** 輸入驗證失敗：`fields` 是欄位名稱到（可直接顯示的）錯誤訊息，整體層級的錯誤放在 `_form`。 */
export interface InvalidInput {
  ok: false;
  reason: "invalid_input";
  fields: Record<string, string[]>;
}

export const invalidInput = (fields: Record<string, string[]>): InvalidInput => ({
  ok: false,
  reason: "invalid_input",
  fields,
});

/** 管理 RPC 沒有有效 Access JWT 時的拒絕結果。 */
export type Unauthorized = { ok: false; reason: "unauthorized" };

/** 管理 RPC 指名的商品不存在。 */
export type ProductNotFound = { ok: false; reason: "product_not_found" };

/** 庫存調整會讓可售數量變成負數而被拒絕。 */
export type InsufficientStock = { ok: false; reason: "insufficient_stock" };
