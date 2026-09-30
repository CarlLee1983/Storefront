import { describe, expect, it } from "vitest";
import { formatDateTime, orderStatusLabel, parseOrderId } from "./labels";

describe("orderStatusLabel", () => {
  it.each([
    ["pending_payment", "待付款"],
    ["paid", "已付款"],
    ["shipped", "已出貨"],
    ["expired", "已逾期"],
    ["cancelled", "已取消"],
  ])("%s → %s", (status, label) => {
    expect(orderStatusLabel(status)).toBe(label);
  });

  it("不認得的狀態原樣顯示，不讓頁面壞掉", () => {
    expect(orderStatusLabel("mystery")).toBe("mystery");
  });
});

describe("formatDateTime", () => {
  it("以台北時間顯示（UTC+8）", () => {
    expect(formatDateTime(Date.UTC(2026, 9, 1, 6, 30, 0))).toContain("14:30");
  });
});

describe("parseOrderId", () => {
  it.each([
    ["12", 12],
    ["1", 1],
  ])("%s 是訂單編號", (value, expected) => {
    expect(parseOrderId(value)).toBe(expected);
  });

  it.each([[undefined], [""], ["0"], ["-1"], ["1.5"], ["abc"], ["01"]])("%s 不是訂單編號", (value) => {
    expect(parseOrderId(value)).toBeNull();
  });
});
