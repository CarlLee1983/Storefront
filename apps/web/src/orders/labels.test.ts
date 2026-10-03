import { describe, expect, it } from "vitest";
import { refundAttemptLabel, refundStatusLabel, customerRefundStatusLabel, customerRefundStatusNote, appointmentSummary, deliveryStatusLabel, formatDateTime, shipmentProgressLabel, shipmentEventKindLabel, orderStatusLabel, shipmentSummary, orderStatusNote, parseOrderId, paymentStatusLabel, refundReasonLabel } from "./labels";
import { customerOrderStatusLabel, customerOrderStatusNote, customerPaymentStatusLabel, customerPaymentStatusNote, customerRefundReasonLabel, customerShipmentSummary } from "./labels";

describe("顧客訂單與付款文案", () => {
  it("已知狀態、物流資訊與退款原因顯示核准內容", () => {
    expect(customerOrderStatusNote("pending_payment", 0)).toContain(formatDateTime(0));
    expect(customerOrderStatusNote("expired", 0)).toContain("狀態可能更新");
    expect(customerShipmentSummary(null, null)).toBe("尚未提供物流單號。");
    expect(customerShipmentSummary(null, "TW123")).toBe("物流單號：TW123");
    expect(customerRefundReasonLabel("duplicate_success")).toBe("同一張訂單有另一筆成功付款");
  });

  it("未知及 prototype 代碼不顯示原始值", () => {
    for (const code of ["future_status", "__proto__", "constructor"]) {
      expect(customerOrderStatusLabel(code)).toBe("訂單狀態待確認");
      expect(customerOrderStatusNote(code, 0)).toContain("無法確認訂單狀態");
      expect(customerPaymentStatusLabel(code)).toBe("付款狀態待確認");
      expect(customerPaymentStatusNote(code)).toContain("無法確認這筆付款");
      expect(customerRefundReasonLabel(code)).toBe("退款原因待確認");
      expect(customerRefundStatusLabel(code)).toBe("退款狀態待確認");
      expect(customerRefundStatusNote(code)).toContain("無法確認這筆退款");
      expect(refundStatusLabel(code)).toBe(code);
    }
  });

  it("顧客只看到「處理中」與「已退回」，不揭露內部的結果不明與明確失敗", () => {
    expect(customerRefundStatusLabel("succeeded")).toBe("已退回原付款方式");
    for (const status of ["pending", "processing", "unknown", "failed"]) {
      expect(customerRefundStatusLabel(status)).toBe("退款處理中");
      expect(customerRefundStatusNote(status)).not.toMatch(/不明|失敗/);
    }
  });
});

describe("管理員的退款進度與嘗試紀錄", () => {
  it("如實區分尚未送出、處理中、結果不明、明確失敗與已退回", () => {
    expect(["pending", "processing", "unknown", "failed", "succeeded"].map(refundStatusLabel)).toEqual([
      "尚未送出", "處理中", "結果不明（須先查證）", "明確失敗（可重試）", "已退回",
    ]);
    expect(refundAttemptLabel("verify", "not_found")).toBe("向閘道查證：閘道從未收過這筆退款");
    expect(refundAttemptLabel("send", "unknown")).toBe("送出退款：結果不明");
    expect(refundAttemptLabel("x", "y")).toBe("x：y");
  });
});

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
    ["partially_shipped", "部分出貨"],
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

describe("appointmentSummary", () => {
  it("顯示議定時段起訖（台北時間）", () => {
    const start = Date.UTC(2026, 9, 10, 1, 0);
    const end = Date.UTC(2026, 9, 10, 4, 0);

    expect(appointmentSummary({ start, end })).toBe(`議定配送時段：${formatDateTime(start)} 至 ${formatDateTime(end)}（台北時間）`);
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

describe("批次配送進度文案", () => {
  it("已知進度與回報種類有專屬名稱，未知及 prototype 代碼不顯示原始值", () => {
    expect(deliveryStatusLabel("delivered")).toBe("已送達");
    expect(deliveryStatusLabel("delivery_failed")).toContain("再次配送");
    expect(deliveryStatusLabel("lost")).toContain("遺失");
    expect(customerRefundReasonLabel("loss")).toContain("遺失");
    expect(refundReasonLabel("loss")).toBe("物流確認遺失");
    expect(customerRefundReasonLabel("shipment_return")).toContain("物流退回");
    expect(refundReasonLabel("shipment_return")).toBe("物流退回檢查完成");
    expect(shipmentEventKindLabel("redelivery")).toBe("再次配送");
    for (const code of ["future", "__proto__", "constructor"]) {
      expect(deliveryStatusLabel(code)).toBe("進度未知");
      expect(shipmentEventKindLabel(code)).toBe("回報");
    }
  });
});

describe("shipmentProgressLabel", () => {
  const at = Date.UTC(2026, 9, 10, 4, 0);

  it("部分遺失且已送達：說明遺失與其餘已送達，附送達時間", () => {
    const label = shipmentProgressLabel("lost", at, true);
    expect(label).toContain("部分商品已確認遺失");
    expect(label).toContain("其餘已送達");
    expect(label).toContain(formatDateTime(at));
  });

  it("全數遺失、晚到的送達回報不改變結果：只說遺失，不顯示送達時間", () => {
    expect(shipmentProgressLabel("lost", at, false)).toBe(deliveryStatusLabel("lost"));
  });

  it("其餘進度沿用原標籤，已送達附送達時間，未送達不附", () => {
    expect(shipmentProgressLabel("delivered", at, true)).toBe(`已送達（實際送達：${formatDateTime(at)}）`);
    expect(shipmentProgressLabel("in_transit", null, true)).toBe(deliveryStatusLabel("in_transit"));
    expect(shipmentProgressLabel("lost", null, true)).toBe(deliveryStatusLabel("lost"));
    expect(shipmentProgressLabel("returned", null, true)).toBe(deliveryStatusLabel("returned"));
    expect(shipmentProgressLabel("returned", at, true)).toContain("部分商品被物流退回倉庫");
    expect(shipmentProgressLabel("returned", at, false)).toBe(deliveryStatusLabel("returned"));
  });
});
