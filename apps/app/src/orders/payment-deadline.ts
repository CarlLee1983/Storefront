/** 付款期限（Payment Deadline）：訂單成立後 15 分鐘內必須完成付款。集中在這一處。 */
export const PAYMENT_WINDOW_MS = 15 * 60 * 1000;

/** 付款（向閘道發起的一次收款）的有效期上限：發起後 10 分鐘（ADR 0001 第一道防線）。 */
export const PAYMENT_LIFETIME_MS = 10 * 60 * 1000;

/** 付款期限前這麼久內不能再發起付款，付款也最晚在付款期限前這麼久失效（ADR 0001），讓遲到的成功盡量不發生。 */
export const PAYMENT_CUTOFF_BEFORE_DEADLINE_MS = 2 * 60 * 1000;

/** 付款最晚失效的時間（送給閘道的 `expiresAt`）：發起後 10 分鐘與付款期限前 2 分鐘，取較早的。 */
export function paymentExpiresAt(now: number, paymentDeadline: number): number {
  return Math.min(now + PAYMENT_LIFETIME_MS, paymentDeadline - PAYMENT_CUTOFF_BEFORE_DEADLINE_MS);
}
