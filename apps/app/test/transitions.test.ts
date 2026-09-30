import { describe, expect, it } from "vitest";
import { ORDER_STATUSES } from "../src/orders/schema";
import { ALLOWED_TRANSITIONS, allowedSources } from "../src/orders/transitions";

describe("訂單狀態轉換表（CONTEXT.md 與 ADR 0001）", () => {
  it("內容與規格一致", () => {
    expect(ALLOWED_TRANSITIONS).toEqual({
      pending_payment: ["paid", "expired", "cancelled"],
      expired: ["paid"],
      paid: ["shipped"],
      shipped: [],
      cancelled: [],
    });
  });

  it("每個狀態都有列出；已出貨與已取消是終點，沒有任何出邊", () => {
    expect(Object.keys(ALLOWED_TRANSITIONS).sort()).toEqual([...ORDER_STATUSES].sort());
    expect(ALLOWED_TRANSITIONS.shipped).toEqual([]);
    expect(ALLOWED_TRANSITIONS.cancelled).toEqual([]);
  });

  it("allowedSources：由目標狀態列出允許的來源狀態", () => {
    expect(allowedSources("cancelled")).toEqual(["pending_payment"]);
    expect(allowedSources("expired")).toEqual(["pending_payment"]);
    expect(allowedSources("paid").sort()).toEqual(["expired", "pending_payment"]);
    expect(allowedSources("shipped")).toEqual(["paid"]);
    expect(allowedSources("pending_payment")).toEqual([]);
  });
});
