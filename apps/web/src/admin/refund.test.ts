import { describe, expect, it } from "vitest";
import { describeRetryFailure, describeRetryOutcome, parseRetryResult } from "./refund";

describe("退款重試的提示", () => {
  it("成功是一般提示，明確失敗與結果不明是錯誤並說明後續", () => {
    expect(describeRetryOutcome("succeeded")).toMatchObject({ isError: false });
    expect(describeRetryOutcome("failed")).toMatchObject({ isError: true, text: expect.stringContaining("額度仍保留") });
    expect(describeRetryOutcome("unknown")).toMatchObject({ isError: true, text: expect.stringContaining("同單其他退款會繼續等待") });
    expect(describeRetryOutcome("whatever").isError).toBe(true);
  });

  it("被拒絕的原因轉成訊息，不認得的用通用訊息", () => {
    expect(describeRetryFailure({ reason: "refund_blocked" })).toContain("另一筆退款結果不明");
    expect(describeRetryFailure({ reason: "refund_in_progress" })).toContain("正在處理中");
    expect(describeRetryFailure({ reason: "boom" })).toBe("操作失敗，請稍後再試");
  });

  it("結果參數只接受已知的狀態", () => {
    expect(parseRetryResult(new URLSearchParams("result=unknown"))).toBe("unknown");
    expect(parseRetryResult(new URLSearchParams("result=<script>"))).toBeNull();
    expect(parseRetryResult(new URLSearchParams(""))).toBeNull();
  });
});
