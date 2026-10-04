import { ALLOWANCE_STATUSES, INVOICE_STATUSES, type AllowanceStatus, type InvoiceStatus } from "@storefront/app/invoices-shared";

const isKnown = (status: string): status is InvoiceStatus => (INVOICE_STATUSES as readonly string[]).includes(status);

/** 發票進度給管理員看的名稱：如實區分待開立、結果不明與明確失敗。不認得的原樣顯示。 */
const INVOICE_STATUS_LABELS: Record<InvoiceStatus, string> = {
  pending: "待開立",
  unknown: "結果不明（須先查證）",
  failed: "明確失敗（可補辦）",
  issued: "已開立",
};

export function invoiceStatusLabel(status: string): string {
  return isKnown(status) ? INVOICE_STATUS_LABELS[status] : status;
}

/** 顧客看的發票進度：只分「已開立」與「開立中」，不揭露內部的不明與失敗；不認得的代碼不顯示原始值。 */
export function customerInvoiceStatusLabel(status: string): string {
  if (status === "issued") return "已開立";
  return isKnown(status) ? "開立中" : "發票狀態待確認";
}

export function customerInvoiceStatusNote(status: string): string {
  if (status === "issued") return "這是演練用的模擬發票，已寄到你的聯絡 email；金額是收款原額。";
  return isKnown(status)
    ? "發票稍後會補開，不影響付款與出貨；開立後會通知你。"
    : "目前無法確認這張發票的狀態，請稍後重新整理；仍有疑問請聯絡 hello@gravito.dev。";
}

/**
 * 憑證待補的說明：已有成功退款、折讓尚未完成時，提醒顧客發票仍顯示原額、沒有扣除退款；沒有待折讓回 null。
 * 不寫成「已結清」或「剩餘金額」：折讓完成（逐筆）之前，原額不代表實際剩下的金額。
 */
export function customerAllowanceNote(pendingAllowanceTwd: number, pendingAllowanceCount: number, format: (amount: number) => string): string | null {
  if (pendingAllowanceCount === 0) return null;
  return `已有 ${pendingAllowanceCount} 筆退款共 NT$ ${format(pendingAllowanceTwd)} 的折讓待補：憑證尚未調整，上方仍顯示開立時的原額，不代表退款後的實際金額；折讓完成後會另行通知。`;
}

const INVOICE_ACTION_LABELS: Record<string, string> = { send: "開立發票", verify: "向發票服務查證" };
const INVOICE_OUTCOME_LABELS: Record<string, string> = {
  succeeded: "成功",
  failed: "明確失敗",
  unknown: "結果不明",
  not_found: "發票服務從未收過這張發票",
};

/** 一次開立嘗試的一行說明（管理員的嘗試紀錄用）。 */
export function invoiceAttemptLabel(action: string, outcome: string): string {
  const actionLabel = Object.hasOwn(INVOICE_ACTION_LABELS, action) ? INVOICE_ACTION_LABELS[action]! : action;
  const outcomeLabel = Object.hasOwn(INVOICE_OUTCOME_LABELS, outcome) ? INVOICE_OUTCOME_LABELS[outcome]! : outcome;
  return `${actionLabel}：${outcomeLabel}`;
}

const isKnownAllowance = (status: string): status is AllowanceStatus => (ALLOWANCE_STATUSES as readonly string[]).includes(status);

/** 折讓進度給管理員看的名稱：如實區分待折讓、結果不明與明確失敗。不認得的原樣顯示。 */
const ALLOWANCE_STATUS_LABELS: Record<AllowanceStatus, string> = {
  pending: "待折讓（尚未送出或等原票開立）",
  unknown: "結果不明（須先查證）",
  failed: "明確失敗（可補辦）",
  issued: "已折讓",
};

export function allowanceStatusLabel(status: string): string {
  return isKnownAllowance(status) ? ALLOWANCE_STATUS_LABELS[status] : status;
}

/**
 * 顧客看的折讓摘要：已折讓的累計（有才顯示），以及憑證上的餘額。
 * 餘額只在原票已開立、且沒有任何未折讓的退款時才給：還有待補的折讓時，憑證尚未反映全部退款，原額減已折讓不等於實際餘額，不能標成已結清。
 */
export function customerAllowanceSummary(
  invoice: { status: string; amountTwd: number; allowedTwd: number; allowedCount: number; pendingAllowanceCount: number },
  format: (amount: number) => string,
): { allowed: string | null; balance: string | null } {
  if (invoice.allowedCount === 0) return { allowed: null, balance: null };
  const allowed = `已折讓 ${invoice.allowedCount} 筆，累計 NT$ ${format(invoice.allowedTwd)}`;
  const settled = invoice.status === "issued" && invoice.pendingAllowanceCount === 0;
  return { allowed, balance: settled ? `折讓後餘額 NT$ ${format(invoice.amountTwd - invoice.allowedTwd)}` : null };
}
