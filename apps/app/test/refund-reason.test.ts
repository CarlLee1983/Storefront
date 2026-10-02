import { describe, expect, it } from "vitest";
import { GatewayError } from "../src/payments/gateway";
import { isExplicitRefundFailure, refundReasonFor } from "../src/payments/refund";

describe("refundReasonFor：付款成功沒讓訂單轉已付款時的退款原因", () => {
  it.each([
    ["expired", "late_success_unreclaimable"],
    ["cancelled", "cancelled_order"],
    ["paid", "duplicate_success"],
    ["partially_shipped", "duplicate_success"],
    ["shipped", "duplicate_success"],
  ] as const)("訂單 %s → %s", (status, reason) => {
    expect(refundReasonFor(status, false)).toBe(reason);
  });

  it("已取消但原本由某筆付款支付（已付款後全部取消）：另一筆成功付款是 duplicate_success", () => {
    expect(refundReasonFor("cancelled", true)).toBe("duplicate_success");
  });

  it("待付款不可能發生（付款成功一定讓待付款訂單轉走）：不退款", () => {
    expect(refundReasonFor("pending_payment", false)).toBeNull();
  });
});

describe("isExplicitRefundFailure：閘道錯誤算明確失敗還是結果不明", () => {
  it.each([
    ["refund_failed 碼（502）", new GatewayError("refund_failed", 502, "x"), true],
    ["409 payment_not_refundable", new GatewayError("payment_not_refundable", 409, "x"), true],
    ["404 refund 相關拒絕", new GatewayError("payment_not_found", 404, "x"), true],
    ["408 請求逾時", new GatewayError("timeout", 408, "x"), false],
    ["429 限流", new GatewayError("rate_limited", 429, "x"), false],
    ["4xx 但回應格式不符（中間層的回應）", new GatewayError("invalid_response", 400, "x"), false],
    ["200 但回應格式不符", new GatewayError("invalid_response", 200, "x"), false],
    ["503", new GatewayError("gateway_error", 503, "x"), false],
    ["502 非明確失敗碼", new GatewayError("gateway_error", 502, "x"), false],
    ["連不上（無狀態）", new GatewayError("unreachable", null, "x"), false],
  ])("%s", (_label, error, explicit) => {
    expect(isExplicitRefundFailure(error)).toBe(explicit);
  });
});
