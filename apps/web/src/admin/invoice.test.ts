import { describe, expect, it } from "vitest";
import { describeAllowanceFailure, describeAllowanceResendOutcome, describeAllowanceRetryOutcome, describeInvoiceFailure, describeInvoiceResult, describeInvoiceRetryOutcome, describeResendOutcome, parseInvoiceResult } from "./invoice";

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

describe("補辦折讓的提示", () => {
  it("成功是一般提示，明確失敗與結果不明是錯誤並說明後續", () => {
    expect(describeAllowanceRetryOutcome("issued")).toMatchObject({ isError: false });
    expect(describeAllowanceRetryOutcome("failed")).toMatchObject({ isError: true, text: expect.stringContaining("可再補辦") });
    expect(describeAllowanceRetryOutcome("unknown")).toMatchObject({ isError: true, text: expect.stringContaining("不會重複折讓") });
    expect(describeAllowanceRetryOutcome("whatever").isError).toBe(true);
  });

  it("重寄折讓通知的投遞成功是一般提示，失敗是錯誤", () => {
    expect(describeAllowanceResendOutcome(true)).toMatchObject({ isError: false });
    expect(describeAllowanceResendOutcome(false).isError).toBe(true);
  });

  it("被拒絕的原因轉成訊息：原票未開立說明會自動補折讓，不認得的用通用訊息", () => {
    expect(describeAllowanceFailure({ reason: "invoice_not_issued" })).toContain("開立後會自動補折讓");
    expect(describeAllowanceFailure({ reason: "allowance_not_issued" })).toContain("沒有通知可重寄");
    expect(describeAllowanceFailure({ reason: "boom" })).toBe("操作失敗，請稍後再試");
  });

  it("結果參數只接受已知的值，並對應到各自的提示", () => {
    expect(parseInvoiceResult(new URLSearchParams("allowance=failed"))).toEqual({ kind: "retry-allowance", status: "failed" });
    expect(parseInvoiceResult(new URLSearchParams("resend-allowance=delivered"))).toEqual({ kind: "resend-allowance", delivered: true });
    expect(parseInvoiceResult(new URLSearchParams("allowance=<script>"))).toBeNull();
    expect(parseInvoiceResult(new URLSearchParams("resend-allowance=x"))).toBeNull();
    expect(describeInvoiceResult(parseInvoiceResult(new URLSearchParams("allowance=issued")))).toMatchObject({ isError: false });
    expect(describeInvoiceResult(null)).toBeNull();
  });
});
