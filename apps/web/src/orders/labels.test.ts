import { describe, expect, it } from "vitest";
import { formatDateTime, orderStatusLabel, shipmentSummary, orderStatusNote, parseOrderId, paymentStatusLabel, refundReasonLabel } from "./labels";

describe("orderStatusNote", () => {
  it("已逾期說明保留已釋放；已取消說明是終點", () => {
    expect(orderStatusNote("expired")).toBe("已超過付款期限，保留的商品已釋放。");
    expect(orderStatusNote("cancelled")).toBe("你已取消這張訂單，保留的商品已釋放，訂單不會再變更。");
  });

  it("其他狀態沒有額外說明", () => {
    for (const status of ["pending_payment", "paid", "shipped", "mystery"]) expect(orderStatusNote(status)).toBeNull();
  });
});

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

describe("paymentStatusLabel", () => {
  it.each([
    ["pending", "等待付款"],
    ["succeeded", "付款成功"],
    ["failed", "付款失敗"],
    ["expired", "已失效"],
    ["refunded", "已退款"],
    ["refund_failed", "退款失敗"],
  ])("%s → %s", (status, label) => {
    expect(paymentStatusLabel(status)).toBe(label);
  });

  it("不認得的狀態原樣顯示", () => {
    expect(paymentStatusLabel("mystery")).toBe("mystery");
  });
});

describe("refundReasonLabel", () => {
  it.each([
    ["late_success_unreclaimable", "付款期限後才收到付款，商品已無庫存"],
    ["cancelled_order", "訂單已取消"],
    ["duplicate_success", "這張訂單重複付款"],
  ])("%s → %s", (reason, label) => {
    expect(refundReasonLabel(reason)).toBe(label);
  });

  it("沒有退款原因回 null；不認得的原因原樣顯示", () => {
    expect(refundReasonLabel(null)).toBeNull();
    expect(refundReasonLabel("mystery")).toBe("mystery");
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

describe("shipmentSummary", () => {
  const shippedAt = Date.UTC(2026, 9, 1, 6, 30, 0);

  it("有物流單號：出貨時間加物流單號", () => {
    expect(shipmentSummary(shippedAt, "TW123")).toBe(`出貨時間：${formatDateTime(shippedAt)}；物流單號：TW123`);
  });

  it("沒附物流單號：顯示（未附）", () => {
    expect(shipmentSummary(shippedAt, null)).toBe(`出貨時間：${formatDateTime(shippedAt)}；物流單號：（未附）`);
  });

  it("沒有出貨時間（不應發生）：只顯示物流單號，不壞掉", () => {
    expect(shipmentSummary(null, null)).toBe("物流單號：（未附）");
  });
});
