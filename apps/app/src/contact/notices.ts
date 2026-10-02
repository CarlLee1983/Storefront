import type { TransactionNotice } from "./notify";

/** 下單通知；一張訂單一封（事件鍵含訂單編號）。 */
export function orderPlacedNotice(customerId: string, order: { id: number; totalTwd: number }): TransactionNotice {
  return {
    customerId,
    kind: "order_placed",
    eventKey: `order_placed:${order.id}`,
    subject: `訂單 #${order.id} 已成立`,
    body: `你的訂單 #${order.id} 已成立，應付 NT$${order.totalTwd}。請在付款期限內完成付款，逾期訂單會自動取消。`,
  };
}

export type PaymentNoticeKind = "payment_succeeded" | "payment_failed" | "payment_unsettled";

/** 付款結果通知；一筆付款一封（事件鍵含付款編號），事件重送與遲到付款都不產生第二封。 */
export function paymentResultNotice(customerId: string, kind: PaymentNoticeKind, payment: { id: number; orderId: number; amountTwd: number }): TransactionNotice {
  const base = { customerId, kind, eventKey: `payment:${payment.id}` };
  const { orderId, amountTwd } = payment;
  switch (kind) {
    case "payment_succeeded":
      return { ...base, subject: `訂單 #${orderId} 付款成功`, body: `訂單 #${orderId} 已收到 NT$${amountTwd} 的付款，我們會盡快安排出貨。` };
    case "payment_failed":
      return { ...base, subject: `訂單 #${orderId} 付款失敗`, body: `訂單 #${orderId} 這次 NT$${amountTwd} 的付款沒有成功，沒有扣款。訂單若仍在付款期限內，可以重新付款。` };
    case "payment_unsettled":
      return { ...base, subject: `訂單 #${orderId} 的付款未能生效`, body: `訂單 #${orderId} 的 NT$${amountTwd} 付款在訂單已無法成立時才收到（例如已取消或庫存不足），這筆款項會退回。` };
  }
}
