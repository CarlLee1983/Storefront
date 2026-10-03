/** 庫存流水來源的顯示名稱；代碼由 App 的 `StockMovementKind` 決定。 */
const MOVEMENT_KIND_LABELS: Record<string, string> = {
  adjustment: "庫存調整",
  dispatch: "交運扣庫",
  migration: "遷移加回",
  return_received: "退貨收回入倉",
  return_inspected: "退貨檢查合格轉可售",
  scrap: "報廢",
  shipment_return_received: "物流退回收回入倉",
  shipment_return_inspected: "物流退回檢查合格轉可售",
};

export function movementKindLabel(kind: string): string {
  return MOVEMENT_KIND_LABELS[kind] ?? kind;
}

/** 網址上的正整數參數（`?variantId=3`）；不是正整數就視為沒有，不呼叫 App 去驗。 */
function positiveInt(value: string | null): number | undefined {
  return value !== null && /^[1-9]\d{0,14}$/.test(value) ? Number(value) : undefined;
}

/** 庫存流水頁的網址篩選 → RPC 輸入；只帶有效的欄位。 */
export function parseMovementFilter(params: URLSearchParams) {
  const variantId = positiveInt(params.get("variantId"));
  const orderId = positiveInt(params.get("orderId"));
  const beforeId = positiveInt(params.get("beforeId"));
  return {
    ...(variantId === undefined ? {} : { variantId }),
    ...(orderId === undefined ? {} : { orderId }),
    ...(beforeId === undefined ? {} : { beforeId }),
  };
}

/** 帶著目前篩選翻到較舊一頁的網址。 */
export function olderMovementsUrl(filter: ReturnType<typeof parseMovementFilter>, beforeId: number): string {
  const params = new URLSearchParams();
  if (filter.variantId !== undefined) params.set("variantId", String(filter.variantId));
  if (filter.orderId !== undefined) params.set("orderId", String(filter.orderId));
  params.set("beforeId", String(beforeId));
  return `/admin/stock-movements?${params}`;
}
