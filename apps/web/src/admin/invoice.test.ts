import { describe, expect, it } from "vitest";
import { describeInvoiceFailure, describeInvoiceRetryOutcome, describeResendOutcome, parseInvoiceResult } from "./invoice";

describe("補辦發票的提示", () => {
  it("成功是一般提示，明確失敗與結果不明是錯誤並說明後續", () => {
    expect(describeInvoiceRetryOutcome("issued")).toMatchObject({ isError: false });
    expect(describeInvoiceRetryOutcome("failed")).toMatchObject({ isError: true, text: expect.stringContaining("可再補辦") });
    expect(describeInvoiceRetryOutcome("unknown")).toMatchObject({ isError: true, text: expect.stringContaining("不會重複開立") });
    expect(describeInvoiceRetryOutcome("whatever").isError).toBe(true);
  });

  it("重寄的投遞成功是一般提示，失敗是錯誤", () => {
    expect(describeResendOutcome(true)).toMatchObject({ isError: false, text: expect.stringContaining("歷史投遞紀錄與憑證內容不變") });
    expect(describeResendOutcome(false).isError).toBe(true);
  });

  it("被拒絕的原因轉成訊息，不認得的用通用訊息", () => {
    expect(describeInvoiceFailure({ reason: "invoice_not_issued" })).toContain("沒有憑證可重寄");
    expect(describeInvoiceFailure({ reason: "no_verified_contact" })).toContain("已驗證的聯絡 email");
    expect(describeInvoiceFailure({ reason: "boom" })).toBe("操作失敗，請稍後再試");
  });

  it("結果參數只接受已知的值", () => {
    expect(parseInvoiceResult(new URLSearchParams("invoice=unknown"))).toEqual({ kind: "retry", status: "unknown" });
    expect(parseInvoiceResult(new URLSearchParams("resend=delivered"))).toEqual({ kind: "resend", delivered: true });
    expect(parseInvoiceResult(new URLSearchParams("invoice=<script>"))).toBeNull();
    expect(parseInvoiceResult(new URLSearchParams("resend=x"))).toBeNull();
    expect(parseInvoiceResult(new URLSearchParams(""))).toBeNull();
  });
});
