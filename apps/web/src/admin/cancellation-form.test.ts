import { describe, expect, it } from "vitest";
import { describeDecideFailure, describeDecideOutcome, decideFormToInput } from "./cancellation-form";

describe("decideFormToInput", () => {
  it("帶入申請編號、按下的按鈕與備註原文", () => {
    const form = new FormData();
    form.set("requestId", "5");
    form.set("decision", "approve");
    form.set("note", " 已確認 ");

    expect(decideFormToInput(form)).toEqual({ requestId: 5, decision: "approve", note: " 已確認 " });
  });

  it("缺欄位時送出 NaN／空字串，由 App 回報錯誤", () => {
    const input = decideFormToInput(new FormData());

    expect(Number.isNaN(input.requestId)).toBe(true);
    expect(input).toMatchObject({ decision: "", note: "" });
  });
});

describe("審核結果文字", () => {
  it("核准依退款進度說明：成功、未完成（不影響取消）、尚未登記", () => {
    expect(describeDecideOutcome("cancellation-approved", "succeeded")).toContain("退款已成功");
    expect(describeDecideOutcome("cancellation-approved", "failed")).toContain("不會恢復出貨");
    expect(describeDecideOutcome("cancellation-approved", null)).toContain("尚未登記");
    expect(describeDecideOutcome("cancellation-rejected", null)).toContain("恢復可交運");
    expect(describeDecideOutcome("other", null)).toBeNull();
  });

  it("失敗原因有對應訊息", () => {
    expect(describeDecideFailure({ reason: "cancellation_already_decided" }).message).toContain("相反的決定");
    expect(describeDecideFailure({ reason: "boom" }).message).toBe("審核失敗，請稍後再試");
  });
});
