import type { PaymentStatus } from "@storefront/app/payments-shared";

/** 訂單狀態（CONTEXT.md 的六種）的顯示名稱；App 回傳的是英文代碼。不認得的原樣顯示。 */
const STATUS_LABELS: Record<string, string> = {
  pending_payment: "待付款",
  paid: "已付款",
  partially_shipped: "部分出貨",
  shipped: "已出貨",
  expired: "已逾期",
  cancelled: "已取消",
};

/** 六種訂單狀態的代碼（後台篩選用），順序即顯示順序。唯一來源是 App 端的 `ORDER_STATUSES`（apps/app/src/orders/schema.ts），新增狀態要兩邊一起改。 */
export const ORDER_STATUS_CODES = Object.keys(STATUS_LABELS);

export function orderStatusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

export function customerOrderStatusLabel(status: string): string {
  return Object.hasOwn(STATUS_LABELS, status) ? STATUS_LABELS[status]! : "訂單狀態待確認";
}

const CUSTOMER_ORDER_NOTES: Record<string, string> = {
  pending_payment: "請在 {付款期限} 前完成付款。",
  paid: "已收到付款，將於付款後 3 個工作天內出貨。",
  partially_shipped: "部分商品已出貨，其餘商品出貨時會另行通知；各批的明細、物流單號請見下方出貨批次。",
  shipped: "商品已全數出貨；各批的物流單號請見下方出貨批次。",
  expired: "已超過付款期限，原先保留的商品已釋放。若稍後收到付款，訂單狀態可能更新；請以此頁顯示為準。",
  cancelled: "這張訂單已取消，無法恢復。",
};

export function customerOrderStatusNote(status: string, paymentDeadline: number): string {
  return (Object.hasOwn(CUSTOMER_ORDER_NOTES, status) ? CUSTOMER_ORDER_NOTES[status]! : "目前無法確認訂單狀態，請稍後重新整理；仍有疑問請聯絡 hello@gravito.dev。")
    .replace("{付款期限}", formatDateTime(paymentDeadline));
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
};

export function paymentStatusLabel(status: string): string {
  return Object.hasOwn(PAYMENT_STATUS_LABELS, status) ? PAYMENT_STATUS_LABELS[status as PaymentStatus] : status;
}

const CUSTOMER_PAYMENT_LABELS: Record<string, string> = {
  pending: "等待付款", succeeded: "付款成功", failed: "付款未完成", expired: "付款已失效",
};

const CUSTOMER_PAYMENT_NOTES: Record<string, string> = {
  pending: "請依付款頁指示完成付款。",
  succeeded: "這筆付款已成功；請以訂單狀態確認後續處理。",
  failed: "這筆付款未完成，若訂單仍可付款，可再試一次。",
  expired: "這筆付款已失效，請查看訂單是否仍可付款。",
};

export function customerPaymentStatusLabel(status: string): string {
  return Object.hasOwn(CUSTOMER_PAYMENT_LABELS, status) ? CUSTOMER_PAYMENT_LABELS[status]! : "付款狀態待確認";
}

export function customerPaymentStatusNote(status: string): string {
  return Object.hasOwn(CUSTOMER_PAYMENT_NOTES, status) ? CUSTOMER_PAYMENT_NOTES[status]! : "目前無法確認這筆付款的狀態，請稍後重新整理；仍有疑問請聯絡 hello@gravito.dev。";
}

const CUSTOMER_REFUND_REASONS: Record<string, string> = {
  late_success_unreclaimable: "付款期限後才收到付款，商品已無法保留",
  cancelled_order: "付款時訂單已取消",
  duplicate_success: "同一張訂單有另一筆成功付款",
  cancellation: "取消申請已核准",
  return: "退貨已收到並檢查完成",
  loss: "物流確認商品遺失",
};

export function customerRefundReasonLabel(reason: string | null): string | null {
  return reason === null ? null : Object.hasOwn(CUSTOMER_REFUND_REASONS, reason) ? CUSTOMER_REFUND_REASONS[reason]! : "退款原因待確認";
}

/** 退款進度（`RefundStatus`）給管理員看的名稱：如實區分尚未送出、結果不明與明確失敗。不認得的原樣顯示。 */
const REFUND_STATUS_LABELS: Record<string, string> = {
  pending: "尚未送出",
  processing: "處理中",
  unknown: "結果不明（須先查證）",
  failed: "明確失敗（可重試）",
  succeeded: "已退回",
};

export function refundStatusLabel(status: string): string {
  return Object.hasOwn(REFUND_STATUS_LABELS, status) ? REFUND_STATUS_LABELS[status]! : status;
}

/** 顧客看的退款進度：只分「已退回」與「處理中」，不揭露內部的不明與失敗；不認得的代碼不顯示原始值。 */
export function customerRefundStatusLabel(status: string): string {
  if (status === "succeeded") return "已退回原付款方式";
  return Object.hasOwn(REFUND_STATUS_LABELS, status) ? "退款處理中" : "退款狀態待確認";
}

export function customerRefundStatusNote(status: string): string {
  if (status === "succeeded") return "這筆款項已退回，實際入帳時間依你的付款機構而定。";
  return Object.hasOwn(REFUND_STATUS_LABELS, status)
    ? "我們正在處理這筆退款，完成後會通知你；如需協助，請聯絡 hello@gravito.dev。"
    : "目前無法確認這筆退款的狀態，請稍後重新整理；仍有疑問請聯絡 hello@gravito.dev。";
}

const REFUND_ACTION_LABELS: Record<string, string> = { send: "送出退款", verify: "向閘道查證" };
const REFUND_OUTCOME_LABELS: Record<string, string> = {
  succeeded: "成功",
  failed: "明確失敗",
  unknown: "結果不明",
  not_found: "閘道從未收過這筆退款",
};

/** 一次退款嘗試的一行說明（管理員的嘗試紀錄用）。 */
export function refundAttemptLabel(action: string, outcome: string): string {
  const actionLabel = Object.hasOwn(REFUND_ACTION_LABELS, action) ? REFUND_ACTION_LABELS[action]! : action;
  const outcomeLabel = Object.hasOwn(REFUND_OUTCOME_LABELS, outcome) ? REFUND_OUTCOME_LABELS[outcome]! : outcome;
  return `${actionLabel}：${outcomeLabel}`;
}

/** 退款觸發原因（`RefundReason`）的顯示說明；沒有退款回 null，不認得的原樣顯示。 */
const REFUND_REASON_LABELS: Record<string, string> = {
  late_success_unreclaimable: "付款期限後才收到付款，商品已無庫存",
  cancelled_order: "訂單已取消",
  duplicate_success: "這張訂單重複付款",
  cancellation: "取消申請核准",
  return: "退貨檢查完成",
  loss: "物流確認遺失",
};

export function refundReasonLabel(reason: string | null): string | null {
  if (reason === null) return null;
  return REFUND_REASON_LABELS[reason] ?? reason;
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

/** 一個出貨批次的出貨資訊一行文字（後台與顧客頁共用）；沒附物流單號顯示「（未附）」。 */
export function shipmentSummary(shippedAt: number | null, trackingNumber: string | null): string {
  const time = shippedAt === null ? "" : `出貨時間：${formatDateTime(shippedAt)}；`;
  return `${time}物流單號：${trackingNumber ?? "（未附）"}`;
}

const DELIVERY_STATUS_LABELS: Record<string, string> = {
  in_transit: "運送中",
  delivery_failed: "配送未成功，等待再次配送",
  delivered: "已送達",
  lost: "已確認遺失，已辦理退款",
};

/** 批次配送進度的顯示名稱；不認得的狀態不顯示原始代碼。 */
export function deliveryStatusLabel(status: string): string {
  return Object.hasOwn(DELIVERY_STATUS_LABELS, status) ? DELIVERY_STATUS_LABELS[status]! : "進度未知";
}

/**
 * 批次進度的顯示文字：確認遺失的批次若已有實際送達時間，依是否還有未遺失的數量說明——
 * 還有未遺失的數量是「部分商品已確認遺失，其餘已送達（時間）」，全數遺失只說遺失（晚到的送達回報不改變結果）。
 */
export function shipmentProgressLabel(status: string, deliveredAt: number | null, hasUnlost: boolean): string {
  if (status === "lost" && deliveredAt !== null) return hasUnlost ? `部分商品已確認遺失（退款事宜另行通知），其餘已送達（實際送達：${formatDateTime(deliveredAt)}）` : deliveryStatusLabel(status);
  return `${deliveryStatusLabel(status)}${deliveredAt !== null ? `（實際送達：${formatDateTime(deliveredAt)}）` : ""}`;
}

const SHIPMENT_EVENT_KIND_LABELS: Record<string, string> = {
  delivered: "送達",
  delivery_failed: "配送失敗",
  redelivery: "再次配送",
};

export function shipmentEventKindLabel(kind: string): string {
  return Object.hasOwn(SHIPMENT_EVENT_KIND_LABELS, kind) ? SHIPMENT_EVENT_KIND_LABELS[kind]! : "回報";
}

/** 大型配送議定的時段一行文字（台北時間）。 */
export function appointmentSummary(appointment: { start: number; end: number }): string {
  return `議定配送時段：${formatDateTime(appointment.start)} 至 ${formatDateTime(appointment.end)}（台北時間）`;
}

export function customerShipmentSummary(shippedAt: number | null, trackingNumber: string | null): string {
  const time = shippedAt === null ? "" : `出貨時間：${formatDateTime(shippedAt)}；`;
  return `${time}${trackingNumber ? `物流單號：${trackingNumber}` : "尚未提供物流單號。"}`;
}

/** 網址上的訂單編號；不是正整數就回傳 null（頁面顯示找不到）。 */
export function parseOrderId(value: string | undefined): number | null {
  return value !== undefined && /^[1-9]\d*$/.test(value) ? Number(value) : null;
}
