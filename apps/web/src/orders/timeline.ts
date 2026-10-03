import type { ProgressFlag, TimelineEvent, TimelineKind, TodoKind } from "@storefront/app/order-timeline";
import { customerRefundReasonLabel, refundReasonLabel } from "./labels";

const money = new Intl.NumberFormat("zh-TW");
const twd = (amount: number | null): string => (amount === null ? "" : `NT$ ${money.format(amount)}`);
const count = (quantity: number | null): string => (quantity === null ? "" : `${quantity} 件`);

/** 時間線事件的一行說明；金額與數量由 App 帶來，這裡只負責用語。不認得的種類顯示通用文字，不顯示原始代碼。 */
const EVENT_TEXT: Record<TimelineKind, (event: TimelineEvent, customer: boolean) => string> = {
  order_placed: () => "訂單成立",
  payment_succeeded: (event) => `付款成功 ${twd(event.amountTwd)}`,
  payment_failed: () => "付款未完成",
  shipment_dispatched: (event) => `出貨：${count(event.quantity)}交運`,
  shipment_delivery_failed: () => "配送未成功，等待再次配送",
  shipment_redelivery: () => "物流再次安排配送",
  shipment_delivered: (event) => `已送達 ${count(event.quantity)}`,
  cancellation_requested: (event) => `申請取消 ${count(event.quantity)}`,
  cancellation_approved: (event) => `取消申請核准（${count(event.quantity)}）`,
  cancellation_rejected: () => "取消申請未核准",
  return_requested: (event) => `申請退貨 ${count(event.quantity)}`,
  return_approved: () => "退貨申請核准",
  return_rejected: () => "退貨申請未核准",
  return_received: (event) => `收回退貨 ${count(event.quantity)}`,
  return_inspected: (event) => `退貨檢查完成（${count(event.quantity)}）`,
  loss_confirmed: (event) => `確認物流遺失 ${count(event.quantity)}`,
  shipment_return_declared: (event) => `物流退回登記 ${count(event.quantity)}`,
  shipment_return_received: (event) => `物流退回收到 ${count(event.quantity)}`,
  shipment_return_inspected: (event) => `物流退回檢查完成（${count(event.quantity)}）`,
  refund_registered: (event, customer) => `退款登記 ${twd(event.amountTwd)}（${(customer ? customerRefundReasonLabel(event.detail) : refundReasonLabel(event.detail ?? ""))}）`,
  refund_failed: (event) => `退款曾明確失敗（第一次）${twd(event.amountTwd)}`,
  refund_succeeded: (event) => `退款已退回 ${twd(event.amountTwd)}`,
  invoice_issued: (event) => `發票已開立 ${twd(event.amountTwd)}`,
  allowance_issued: (event) => `折讓完成 ${twd(event.amountTwd)}`,
};

export function timelineEventText(event: TimelineEvent, customer: boolean): string {
  const text = Object.hasOwn(EVENT_TEXT, event.kind) ? EVENT_TEXT[event.kind](event, customer) : "進度更新";
  return text.replace(/\s+（/g, "（").trim();
}

const FLAG_LABELS: Record<ProgressFlag, { customer: string; admin: string }> = {
  awaiting_dispatch: { customer: "尚有商品待出貨", admin: "尚有商品待出貨" },
  partially_delivered: { customer: "部分商品已送達", admin: "部分商品已送達" },
  delivery_failed: { customer: "有批次配送未成功", admin: "有批次配送未成功，待再次配送" },
  cancellation_pending: { customer: "取消申請審核中", admin: "取消申請待審核" },
  partially_cancelled: { customer: "部分商品已取消", admin: "部分商品已取消" },
  return_open: { customer: "退貨處理中", admin: "退貨處理中" },
  shipment_return_open: { customer: "物流退回處理中", admin: "物流退回處理中" },
  lost: { customer: "有商品確認遺失", admin: "有商品確認遺失" },
  refund_open: { customer: "退款處理中", admin: "有退款尚未完成" },
  refund_failed: { customer: "退款處理中", admin: "退款明確失敗（可重試）" },
  refund_unknown: { customer: "退款處理中", admin: "退款結果不明（須先查證）" },
  invoice_pending: { customer: "發票開立中", admin: "發票待補" },
  allowance_pending: { customer: "發票折讓待補", admin: "憑證折讓待補" },
};

/** 進度旗標的顯示名稱；不認得的旗標不顯示（回 null）。 */
export function progressFlagLabel(flag: string, customer: boolean): string | null {
  return Object.hasOwn(FLAG_LABELS, flag) ? FLAG_LABELS[flag as ProgressFlag][customer ? "customer" : "admin"] : null;
}

const TODO_LABELS: Record<TodoKind, string> = {
  payment_attention: "付款需要處理",
  delivery_failed: "批次配送失敗，待再次配送",
  cancellation_review: "取消申請待審核",
  return_handle: "退貨待處理",
  shipment_return_handle: "物流退回待處理",
  refund_handle: "退款待處理",
  refund_unregistered: "款項尚未登記退款",
  invoice_handle: "發票待補辦",
  allowance_handle: "折讓待補辦",
};

export function todoLabel(todo: { kind: string; amountTwd: number | null }): string {
  const text = Object.hasOwn(TODO_LABELS, todo.kind) ? TODO_LABELS[todo.kind as TodoKind] : "待處理";
  return todo.amountTwd === null ? text : `${text} ${twd(todo.amountTwd)}`;
}

export function quantityRows(quantities: Record<string, number>): { label: string; value: number }[] {
  const rows: [string, string][] = [["ordered", "訂購"], ["dispatched", "已交運"], ["delivered", "已送達"], ["awaitingDispatch", "待出貨"], ["pendingCancellation", "取消審核中"], ["cancelled", "已取消"], ["openReturn", "退貨處理中"], ["returned", "已退貨"], ["shipmentReturned", "物流退回"], ["lost", "遺失"]];
  return rows.map(([key, label]) => ({ label, value: quantities[key] ?? 0 }));
}

export function moneyRows(money: Record<string, number>): { label: string; value: string }[] {
  const rows: [string, string][] = [["paidTwd", "已收款"], ["refundedTwd", "已退回"], ["refundOpenTwd", "待退回款項"], ["allowedTwd", "憑證已折讓"], ["allowancePendingTwd", "折讓待補"]];
  return rows.map(([key, label]) => ({ label, value: twd(money[key] ?? 0) }));
}
