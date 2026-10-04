// 模擬發票的共用常數與型別：App 內部與 Web（經 `@storefront/app/invoices-shared`）共用。不 import 任何東西。

/**
 * 模擬發票（CONTEXT.md「發票」）開立的進度，一張成功收款一張發票：
 * - `pending`：已記下開立義務、尚未送出（含程序中斷、沒有結果的）；
 * - `unknown`：結果不明（逾時、連不上、回應異常），須先向發票服務查證，不盲目重送；
 * - `failed`：發票服務明確失敗，可補辦；
 * - `issued`：已開立。
 * 開立失敗不阻擋付款、出貨或退款。
 */
export const INVOICE_STATUSES = ["pending", "unknown", "failed", "issued"] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

/** 開立嘗試的動作：直接送出，或結果不明後先向發票服務查證。 */
export const INVOICE_ATTEMPT_ACTIONS = ["send", "verify"] as const;
export type InvoiceAttemptAction = (typeof INVOICE_ATTEMPT_ACTIONS)[number];

/** 一次嘗試的結果：成功、明確失敗、結果不明，或查證時發票服務從未收過這張發票。 */
export const INVOICE_ATTEMPT_OUTCOMES = ["succeeded", "failed", "unknown", "not_found"] as const;
export type InvoiceAttemptOutcome = (typeof INVOICE_ATTEMPT_OUTCOMES)[number];

/**
 * 折讓（CONTEXT.md「折讓」）的進度，一筆成功退款一筆折讓，狀態語意同發票：
 * - `pending`：待折讓義務已成立、尚未送出（原票尚未開立，或程序中斷沒有結果）；
 * - `unknown`：結果不明，須先向發票服務查證，不盲目重送；
 * - `failed`：發票服務明確失敗，可補辦；
 * - `issued`：已折讓。
 * 折讓失敗或延遲不阻擋付款、出貨或退款。
 */
export const ALLOWANCE_STATUSES = ["pending", "unknown", "failed", "issued"] as const;
export type AllowanceStatus = (typeof ALLOWANCE_STATUSES)[number];
