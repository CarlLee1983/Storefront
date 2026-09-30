/** 訂單狀態（CONTEXT.md 的五種）的顯示名稱；App 回傳的是英文代碼。不認得的原樣顯示。 */
const STATUS_LABELS: Record<string, string> = {
  pending_payment: "待付款",
  paid: "已付款",
  shipped: "已出貨",
  expired: "已逾期",
  cancelled: "已取消",
};

export function orderStatusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

const dateTimeFormat = new Intl.DateTimeFormat("zh-TW", {
  timeZone: "Asia/Taipei",
  dateStyle: "medium",
  timeStyle: "medium",
  hour12: false,
});

/** UTC epoch 毫秒 → 台北時間的日期時間文字。 */
export function formatDateTime(epochMs: number): string {
  return dateTimeFormat.format(epochMs);
}

/** 網址上的訂單編號；不是正整數就回傳 null（頁面顯示找不到）。 */
export function parseOrderId(value: string | undefined): number | null {
  return value !== undefined && /^[1-9]\d*$/.test(value) ? Number(value) : null;
}
