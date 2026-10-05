import type { CancellationView } from "../cancellations/queries";
import type { InvoiceSummary } from "../invoices/queries";
import type { PaymentSummary } from "../payments/queries";
import type { RefundAttemptView, RefundSummary } from "../payments/refunds";
import type { LossView } from "../shipments/loss-queries";
import type { ShipmentView } from "../shipments/queries";
import type { ReturnView } from "../returns/queries";
import type { ShipmentReturnView } from "../shipment-returns/queries";
import type { TimelineFacts } from "./timeline-facts";
import type { OrderLineView } from "./queries";
import type { OrderStatus } from "./schema";

/**
 * 訂單時間線與進度：從各域既有的事實「推導」的讀取模型，沒有自己的資料表或狀態欄位，所以不會與各域的畫面脫節。
 * 事件只取各域的業務事實時間（下單、付款結果、取消與退貨審核、出貨、配送異常、退款登記與完成、發票與折讓）；
 * 退款、開立、折讓的技術嘗試（attempts）與通知重寄不成為事件，同一筆退款重試多次仍只有一筆登記、一筆完成。
 * 時間一律 UTC epoch 毫秒，台北時區的顯示在 Web。
 */

/** 事件種類，順序同時是「同一時間」事件的先後（例如下單永遠在付款之前、申請在審核之前、退款登記在完成之前）。 */
export const TIMELINE_KINDS = [
  "order_placed",
  "payment_succeeded",
  "payment_failed",
  "shipment_dispatched",
  "shipment_delivery_failed",
  "shipment_redelivery",
  "shipment_delivered",
  "cancellation_requested",
  "cancellation_approved",
  "cancellation_rejected",
  "return_requested",
  "return_approved",
  "return_rejected",
  "return_received",
  "return_inspected",
  "loss_confirmed",
  "shipment_return_declared",
  "shipment_return_received",
  "shipment_return_inspected",
  "refund_registered",
  "refund_failed",
  "refund_succeeded",
  "invoice_issued",
  "allowance_issued",
] as const;
export type TimelineKind = (typeof TIMELINE_KINDS)[number];

const KIND_RANK = new Map<TimelineKind, number>(TIMELINE_KINDS.map((kind, index) => [kind, index]));

export interface TimelineEvent {
  /** 穩定識別（種類加來源編號），畫面的 key 用。 */
  id: string;
  at: number;
  kind: TimelineKind;
  /** 來源紀錄編號（批次、申請、退款、發票…）；下單為訂單編號。 */
  refId: number;
  /** 涉及的數量與金額（新台幣整數元）；該事件沒有時為 null。 */
  quantity: number | null;
  amountTwd: number | null;
  /** 補充代碼（退款原因）；沒有時為 null。 */
  detail: string | null;
  /** 操作人 email，只有管理員檢視才有。 */
  actor?: string | null;
}

export const PROGRESS_FLAGS = [
  "awaiting_dispatch",
  "partially_delivered",
  "delivery_failed",
  "cancellation_pending",
  "partially_cancelled",
  "return_open",
  "shipment_return_open",
  "lost",
  "refund_open",
  "refund_failed",
  "refund_unknown",
  "invoice_pending",
  "allowance_pending",
] as const;
export type ProgressFlag = (typeof PROGRESS_FLAGS)[number];

/** 數量與款項的彙總：各數字都由各域既有檢視加總而來，與各域畫面一致（可對帳）。 */
export interface TimelineProgress {
  quantities: {
    ordered: number;
    dispatched: number;
    /** 已送達：送達批次的數量，扣掉其中遺失與被物流退回的。 */
    delivered: number;
    cancelled: number;
    pendingCancellation: number;
    returned: number;
    openReturn: number;
    lost: number;
    shipmentReturned: number;
    /** 還沒交運、也沒被取消占用的數量。 */
    awaitingDispatch: number;
  };
  money: {
    paidTwd: number;
    /** 已確認退回的退款合計。 */
    refundedTwd: number;
    /** 已登記、尚未成功的退款合計（含失敗與結果不明）。 */
    refundOpenTwd: number;
    /** 憑證已折讓的合計，與發票檢視的 `allowedTwd` 相同。 */
    allowedTwd: number;
    allowancePendingTwd: number;
  };
  /** 同時成立的進度旗標（不以單一狀態覆蓋）；顧客看不到退款失敗與結果不明的區別，一律是 `refund_open`。 */
  flags: ProgressFlag[];
}

export const TODO_KINDS = [
  "payment_attention",
  "delivery_failed",
  "cancellation_review",
  "return_handle",
  "shipment_return_handle",
  "refund_handle",
  "refund_unregistered",
  "invoice_handle",
  "allowance_handle",
] as const;
export type TodoKind = (typeof TODO_KINDS)[number];

/** 管理員的待辦入口：連到本單頁面上可操作的區塊。 */
export interface TimelineTodo {
  kind: TodoKind;
  refId: number;
  amountTwd: number | null;
  href: string;
}

export type CustomerTimeline = { events: TimelineEvent[]; progress: TimelineProgress };
export type AdminTimeline = CustomerTimeline & { todos: TimelineTodo[] };

type AdminReturnExtras = { decidedBy?: string | null; receivedBy?: string | null; inspectedBy?: string | null };

/** 推導時間線需要的各域檢視；管理員檢視是這些型別的超集，多出來的欄位（操作人、嘗試紀錄）只在管理員時間線被讀取。 */
export interface TimelineSource {
  order: { id: number; status: OrderStatus; createdAt: number; lines: OrderLineView[]; shipments: ShipmentView[] };
  payments: PaymentSummary[];
  refunds: (RefundSummary & { attempts?: RefundAttemptView[] })[];
  invoices: InvoiceSummary[];
  cancellations: (CancellationView & { decidedBy?: string | null })[];
  returns: (ReturnView & AdminReturnExtras)[];
  losses: (LossView & { actor?: string })[];
  shipmentReturns: (ShipmentReturnView & { actor?: string; receivedBy?: string | null; inspectedBy?: string | null })[];
  facts: TimelineFacts;
}

const sum = <T>(items: T[], pick: (item: T) => number): number => items.reduce((total, item) => total + pick(item), 0);

/** 依時間、種類順序、來源編號排序（同時間的次序固定）。事件 id 由來源保證唯一，不在這裡去重（重複代表來源重複讀取，應讓測試失敗）。 */
function sortEvents(events: TimelineEvent[]): TimelineEvent[] {
  return [...events].sort(
    (a, b) => a.at - b.at || KIND_RANK.get(a.kind)! - KIND_RANK.get(b.kind)! || a.refId - b.refId || a.id.localeCompare(b.id),
  );
}

/**
 * 只留紀錄、不改進度的物流回報（見 `shipments/events.ts`）：發生在實際送達之後，或在確認遺失、登記物流退回之後的失敗與再次配送回報，
 * 不是業務事件；送達之前的失敗與再次配送照常列出。
 */
function isRecordOnly(event: { shipmentId: number; occurredAt: number }, source: TimelineSource): boolean {
  const shipment = source.order.shipments.find((candidate) => candidate.id === event.shipmentId);
  if (shipment?.deliveredAt != null && event.occurredAt > shipment.deliveredAt) return true;
  if (source.losses.some((loss) => loss.shipmentId === event.shipmentId && event.occurredAt > loss.confirmedAt)) return true;
  return source.shipmentReturns.some((sentBack) => sentBack.shipmentId === event.shipmentId && sentBack.status !== "not_received" && event.occurredAt > sentBack.declaredAt);
}

function collectEvents(source: TimelineSource, admin: boolean): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  const add = (kind: TimelineKind, refId: number, at: number | null, extra: { quantity?: number; amountTwd?: number; detail?: string; actor?: string | null } = {}) => {
    if (at === null) return;
    const { actor, ...rest } = extra;
    events.push({ id: `${kind}:${refId}`, at, kind, refId, quantity: rest.quantity ?? null, amountTwd: rest.amountTwd ?? null, detail: rest.detail ?? null, ...(admin ? { actor: actor ?? null } : {}) });
  };

  add("order_placed", source.order.id, source.order.createdAt);
  for (const result of source.facts.paymentResults) {
    const amountTwd = source.payments.find((payment) => payment.id === result.paymentId)?.amountTwd;
    add(result.outcome === "succeeded" ? "payment_succeeded" : "payment_failed", result.paymentId, result.at, { amountTwd });
  }
  for (const shipment of source.order.shipments) {
    const quantity = sum(shipment.items, (item) => item.quantity);
    add("shipment_dispatched", shipment.id, shipment.shippedAt, { quantity });
    // 已送達以實際送達時間為準（部分遺失的批次進度是 lost、仍可能已送達）；全數遺失或退回、沒有東西送達的批次不列
    const delivered = sum(shipment.items, (item) => item.quantity - item.lostQuantity - item.returnedQuantity);
    if (delivered > 0) add("shipment_delivered", shipment.id, shipment.deliveredAt, { quantity: delivered });
  }
  // 物流回報：管理員檢視的批次已帶回報（facts 不重查），顧客檢視由 facts 補；兩者只會有一邊有資料
  const reports = [...source.facts.shipmentEvents, ...source.order.shipments.flatMap((shipment) => shipment.events.map((event) => ({ id: event.id, shipmentId: shipment.id, kind: event.kind, occurredAt: event.occurredAt })))];
  for (const event of reports) {
    if (event.kind === "delivered" || isRecordOnly(event, source)) continue;
    add(event.kind === "delivery_failed" ? "shipment_delivery_failed" : "shipment_redelivery", event.id, event.occurredAt, { detail: `shipment:${event.shipmentId}` });
  }
  for (const request of source.cancellations) {
    const quantity = sum(request.items, (item) => item.quantity);
    add("cancellation_requested", request.id, request.requestedAt, { quantity });
    if (request.status !== "pending") add(request.status === "approved" ? "cancellation_approved" : "cancellation_rejected", request.id, request.decidedAt, { quantity, actor: request.decidedBy });
  }
  for (const request of source.returns) {
    const quantity = sum(request.items, (item) => item.quantity);
    add("return_requested", request.id, request.requestedAt, { quantity });
    if (request.status !== "pending") add(request.status === "rejected" ? "return_rejected" : "return_approved", request.id, request.decidedAt, { quantity, actor: request.decidedBy });
    add("return_received", request.id, request.receivedAt, { quantity: sum(request.items, (item) => item.receivedQuantity ?? 0), actor: request.receivedBy });
    add("return_inspected", request.id, request.inspectedAt, { quantity: sum(request.items, (item) => (item.sellableQuantity ?? 0) + (item.damagedQuantity ?? 0)), actor: request.inspectedBy });
  }
  for (const loss of source.losses) add("loss_confirmed", loss.id, loss.confirmedAt, { quantity: sum(loss.items, (item) => item.quantity), actor: loss.actor });
  for (const sentBack of source.shipmentReturns) {
    add("shipment_return_declared", sentBack.id, sentBack.declaredAt, { quantity: sum(sentBack.items, (item) => item.quantity + item.foundLostQuantity), actor: sentBack.actor });
    add("shipment_return_received", sentBack.id, sentBack.receivedAt, { quantity: sum(sentBack.items, (item) => (item.receivedQuantity ?? 0) + (item.receivedFoundLostQuantity ?? 0)), actor: sentBack.receivedBy });
    add("shipment_return_inspected", sentBack.id, sentBack.inspectedAt, { quantity: sum(sentBack.items, (item) => (item.sellableQuantity ?? 0) + (item.damagedQuantity ?? 0)), actor: sentBack.inspectedBy });
  }
  for (const refund of source.refunds) {
    add("refund_registered", refund.id, refund.createdAt, { amountTwd: refund.amountTwd, detail: refund.reason });
    add("refund_succeeded", refund.id, refund.settledAt, { amountTwd: refund.amountTwd, detail: refund.reason });
    // 明確失敗只在管理員時間線：取第一次明確失敗的嘗試時間，後續重試不再多一筆事件
    const firstFailure = admin ? refund.attempts?.find((attempt) => attempt.outcome === "failed") : undefined;
    if (firstFailure) add("refund_failed", refund.id, firstFailure.at, { amountTwd: refund.amountTwd, detail: refund.reason });
  }
  for (const invoice of source.invoices) add("invoice_issued", invoice.id, invoice.issuedAt, { amountTwd: invoice.amountTwd });
  for (const allowance of source.facts.allowances) add("allowance_issued", allowance.id, allowance.issuedAt, { amountTwd: allowance.amountTwd });
  return sortEvents(events);
}

function buildProgress(source: TimelineSource, admin: boolean): TimelineProgress {
  const { lines, shipments } = source.order;
  const quantities = {
    ordered: sum(lines, (line) => line.quantity),
    dispatched: sum(lines, (line) => line.shippedQuantity),
    delivered: sum(shipments.filter((shipment) => shipment.deliveredAt !== null), (shipment) => sum(shipment.items, (item) => item.quantity - item.lostQuantity - item.returnedQuantity)),
    cancelled: sum(lines, (line) => line.cancelledQuantity),
    pendingCancellation: sum(lines, (line) => line.pendingCancellationQuantity),
    returned: sum(lines, (line) => line.returnedQuantity),
    openReturn: sum(lines, (line) => line.openReturnQuantity),
    lost: sum(lines, (line) => line.lostQuantity),
    shipmentReturned: sum(lines, (line) => line.shipmentReturnedQuantity),
    awaitingDispatch: sum(lines, (line) => line.quantity - line.shippedQuantity - line.cancelledQuantity - line.pendingCancellationQuantity),
  };
  const openRefunds = source.refunds.filter((refund) => refund.status !== "succeeded");
  const openAllowances = source.facts.allowances.filter((allowance) => allowance.status !== "issued");
  const money = {
    paidTwd: sum(source.payments.filter((payment) => payment.status === "succeeded"), (payment) => payment.amountTwd),
    refundedTwd: sum(source.refunds.filter((refund) => refund.status === "succeeded"), (refund) => refund.amountTwd),
    refundOpenTwd: sum(openRefunds, (refund) => refund.amountTwd),
    allowedTwd: sum(source.facts.allowances.filter((allowance) => allowance.status === "issued"), (allowance) => allowance.amountTwd),
    allowancePendingTwd: sum(openAllowances, (allowance) => allowance.amountTwd),
  };

  const stillToDeliver = quantities.ordered - quantities.cancelled - quantities.lost - quantities.shipmentReturned;
  const active: Record<ProgressFlag, boolean> = {
    awaiting_dispatch: (source.order.status === "paid" || source.order.status === "partially_shipped") && quantities.awaitingDispatch > 0,
    partially_delivered: quantities.delivered > 0 && quantities.delivered < stillToDeliver,
    delivery_failed: shipments.some((shipment) => shipment.deliveryStatus === "delivery_failed"),
    cancellation_pending: quantities.pendingCancellation > 0,
    partially_cancelled: quantities.cancelled > 0,
    return_open: quantities.openReturn > 0,
    shipment_return_open: source.shipmentReturns.some((sentBack) => sentBack.status === "returning" || sentBack.status === "received"),
    lost: quantities.lost > 0,
    refund_open: openRefunds.length > 0,
    refund_failed: admin && openRefunds.some((refund) => refund.status === "failed"),
    refund_unknown: admin && openRefunds.some((refund) => refund.status === "unknown"),
    invoice_pending: source.invoices.some((invoice) => invoice.status !== "issued"),
    allowance_pending: openAllowances.length > 0,
  };
  return { quantities, money, flags: PROGRESS_FLAGS.filter((flag) => active[flag]) };
}

function buildTodos(source: TimelineSource): TimelineTodo[] {
  const base = `/admin/orders/${source.order.id}`;
  const todos: TimelineTodo[] = [];
  const add = (kind: TodoKind, refId: number, amountTwd: number | null, anchor: string) => todos.push({ kind, refId, amountTwd, href: `${base}#${anchor}` });

  for (const payment of source.payments) if (payment.needsAttention) add("payment_attention", payment.id, payment.amountTwd, "payments");
  for (const shipment of source.order.shipments) if (shipment.deliveryStatus === "delivery_failed") add("delivery_failed", shipment.id, null, "shipments");
  for (const request of source.cancellations) {
    if (request.status === "pending") add("cancellation_review", request.id, null, "cancellations");
    else if (request.status === "approved" && request.refund === null && (request.goodsTwd ?? 0) + (request.shippingTwd ?? 0) > 0) add("refund_unregistered", request.id, (request.goodsTwd ?? 0) + (request.shippingTwd ?? 0), "cancellations");
  }
  for (const request of source.returns) {
    if (request.status === "pending" || request.status === "approved" || request.status === "received") add("return_handle", request.id, null, "returns");
    else if (request.status === "completed" && request.refund === null && (request.goodsTwd ?? 0) + (request.shippingTwd ?? 0) > 0) add("refund_unregistered", request.id, (request.goodsTwd ?? 0) + (request.shippingTwd ?? 0), "returns");
  }
  for (const sentBack of source.shipmentReturns) {
    if (sentBack.status === "returning" || sentBack.status === "received") add("shipment_return_handle", sentBack.id, null, "shipment-returns");
    else if (sentBack.status === "completed" && sentBack.refund === null && (sentBack.goodsTwd ?? 0) + (sentBack.shippingTwd ?? 0) > 0) add("refund_unregistered", sentBack.id, (sentBack.goodsTwd ?? 0) + (sentBack.shippingTwd ?? 0), "shipment-returns");
  }
  for (const loss of source.losses) if (loss.refund === null && loss.goodsTwd + loss.shippingTwd > 0) add("refund_unregistered", loss.id, loss.goodsTwd + loss.shippingTwd, "losses");
  for (const refund of source.refunds) if (refund.status !== "succeeded") add("refund_handle", refund.id, refund.amountTwd, "refunds");
  for (const invoice of source.invoices) if (invoice.status !== "issued") add("invoice_handle", invoice.id, invoice.amountTwd, "invoices");
  for (const allowance of source.facts.allowances) if (allowance.status !== "issued") add("allowance_handle", allowance.refundId, allowance.amountTwd, "invoices");
  return todos;
}

/** 顧客時間線：只含業務事實，沒有操作人、技術嘗試、備註與冪等鍵，也沒有待辦入口。 */
export function buildCustomerTimeline(source: TimelineSource): CustomerTimeline {
  return { events: collectEvents(source, false), progress: buildProgress(source, false) };
}

/** 管理員時間線：多了操作人、第一次明確失敗的退款，以及連到本單可操作區塊的待辦入口。 */
export function buildAdminTimeline(source: TimelineSource): AdminTimeline {
  return { events: collectEvents(source, true), progress: buildProgress(source, true), todos: buildTodos(source) };
}
