import { describe, expect, it } from "vitest";
import { refundReasonFor } from "../src/payments/refund";

describe("refundReasonFor：付款成功沒讓訂單轉已付款時的退款原因", () => {
  it.each([
    ["expired", "late_success_unreclaimable"],
    ["cancelled", "cancelled_order"],
    ["paid", "duplicate_success"],
    ["partially_shipped", "duplicate_success"],
    ["shipped", "duplicate_success"],
  ] as const)("訂單 %s → %s", (status, reason) => {
    expect(refundReasonFor(status)).toBe(reason);
  });

  it("待付款不可能發生（付款成功一定讓待付款訂單轉走）：不退款", () => {
    expect(refundReasonFor("pending_payment")).toBeNull();
  });
});
