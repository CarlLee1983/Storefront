import { describe, expect, it } from "vitest";
import { describeReconcileFailure, describeReconcileOutcome, parseReconcileResult, reconcileSourceLabel } from "./payment-reconcile";

describe("付款補查的提示", () => {
  it("套用與失效是成功提示，待辦帶出原因並標為錯誤", () => {
    expect(describeReconcileOutcome("settled")).toMatchObject({ isError: false });
    expect(describeReconcileOutcome("issue", "gateway_mismatch")).toMatchObject({ isError: true, text: expect.stringContaining("金額或訂單參照") });
    expect(describeReconcileOutcome("issue", "nope").text).toContain("原因不明");
  });

  it("結果參數只接受已知的結果與原因", () => {
    expect(parseReconcileResult(new URLSearchParams("result=issue&reason=result_unclear"))).toEqual({ outcome: "issue", reason: "result_unclear" });
    expect(parseReconcileResult(new URLSearchParams("result=issue&reason=<script>"))).toEqual({ outcome: "issue", reason: null });
    expect(parseReconcileResult(new URLSearchParams("result=hacked"))).toBeNull();
    expect(parseReconcileResult(new URLSearchParams(""))).toBeNull();
  });

  it("失敗訊息與觸發者顯示", () => {
    expect(describeReconcileFailure({ reason: "payment_not_pending" })).toContain("已經有結果");
    expect(describeReconcileFailure({ reason: "boom" })).toBe("操作失敗，請稍後再試");
    expect(reconcileSourceLabel("cron")).toBe("系統排程");
    expect(reconcileSourceLabel("a@b.test")).toBe("a@b.test");
  });
});
