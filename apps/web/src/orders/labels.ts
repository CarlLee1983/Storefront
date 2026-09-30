import type { PaymentStatus } from "@storefront/app/payments-shared";

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

const STATUS_NOTES: Record<string, string> = {
  expired: "已超過付款期限，保留的商品已釋放。",
  cancelled: "你已取消這張訂單，保留的商品已釋放，訂單不會再變更。",
};

/** 已逾期、已取消的補充說明（依 CONTEXT.md）；其他狀態沒有，回傳 null。 */
export function orderStatusNote(status: string): string | null {
  return STATUS_NOTES[status] ?? null;
}

/** 付款（Payment）狀態的顯示名稱；App 回傳的是英文代碼，與金流閘道的狀態一一對應。 */
const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = {
  pending: "等待付款",
  succeeded: "付款成功",
  failed: "付款失敗",
  expired: "已失效",
  refunded: "已退款",
  refund_failed: "退款失敗",
};

export function paymentStatusLabel(status: string): string {
  return Object.hasOwn(PAYMENT_STATUS_LABELS, status) ? PAYMENT_STATUS_LABELS[status as PaymentStatus] : status;
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
