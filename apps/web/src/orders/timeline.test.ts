import { describe, expect, it } from "vitest";
import { progressFlagLabel, timelineEventText, todoLabel } from "./timeline";

const event = (kind: string, extra: Record<string, unknown> = {}) => ({ id: `${kind}:1`, at: 0, kind, refId: 1, quantity: null, amountTwd: null, detail: null, ...extra }) as Parameters<typeof timelineEventText>[0];

describe("時間線用語", () => {
  it("事件文字帶數量與金額，退款原因顧客與管理員各用自己的用語", () => {
    expect(timelineEventText(event("shipment_delivered", { quantity: 2 }), true)).toBe("已送達 2 件");
    expect(timelineEventText(event("refund_succeeded", { amountTwd: 6700 }), true)).toBe("退款已退回 NT$ 6,700");
    expect(timelineEventText(event("refund_registered", { amountTwd: 320, detail: "cancellation" }), true)).not.toBe(timelineEventText(event("refund_registered", { amountTwd: 320, detail: "cancellation" }), false));
  });

  it("不認得的事件種類顯示通用文字，不顯示原始代碼", () => {
    expect(timelineEventText(event("future_kind"), true)).toBe("進度更新");
  });

  it("顧客看不到退款失敗與結果不明的區別；管理員如實區分", () => {
    expect(progressFlagLabel("refund_failed", true)).toBe("退款處理中");
    expect(progressFlagLabel("refund_unknown", true)).toBe("退款處理中");
    expect(progressFlagLabel("refund_failed", false)).toContain("明確失敗");
    expect(progressFlagLabel("refund_unknown", false)).toContain("結果不明");
    expect(progressFlagLabel("future_flag", true)).toBeNull();
  });

  it("待辦文字帶金額；不認得的待辦顯示通用文字", () => {
    expect(todoLabel({ kind: "refund_handle", amountTwd: 320 })).toBe("退款待處理 NT$ 320");
    expect(todoLabel({ kind: "future", amountTwd: null })).toBe("待處理");
  });
});
