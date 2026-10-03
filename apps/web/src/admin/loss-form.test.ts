import { describe, expect, it } from "vitest";
import { describeLossFailure, describeLossOutcome, lossFormToInput } from "./loss-form";

describe("lossFormToInput", () => {
  it("每筆明細一個欄位，留空或 0 不算遺失，其餘欄位忽略", () => {
    const form = new FormData();
    form.set("shipmentId", "7");
    form.set("lossKey", "abc");
    form.set("note", " 物流查證遺失 ");
    form.set("lost-11", "2");
    form.set("lost-12", "");
    form.set("lost-13", "0");
    form.set("other", "9");

    expect(lossFormToInput(form)).toEqual({ shipmentId: 7, lossKey: "abc", items: [{ orderLineId: 11, quantity: 2 }], note: " 物流查證遺失 " });
  });

  it("非數字與負數原樣交給 App 驗證，沒填任何數量送出空清單", () => {
    const form = new FormData();
    form.set("lost-1", "-1");
    form.set("lost-2", "x");

    const input = lossFormToInput(form);
    expect(input.items[0]).toEqual({ orderLineId: 1, quantity: -1 });
    expect(Number.isNaN(input.items[1]!.quantity)).toBe(true);
    expect(lossFormToInput(new FormData()).items).toEqual([]);
  });
});

describe("describeLossFailure", () => {
  it("已知原因有專屬訊息，未知原因用通用訊息，不洩漏代碼", () => {
    expect(describeLossFailure({ reason: "shipment_delivered" }).message).toContain("已經送達");
    expect(describeLossFailure({ reason: "loss_quantity_exceeded" }).message).toContain("退貨申請");
    expect(describeLossFailure({ reason: "boom" }).message).toBe("確認遺失失敗，請稍後再試");
  });
});

describe("describeLossOutcome", () => {
  it("只認得 loss-confirmed，依退款進度附說明", () => {
    expect(describeLossOutcome("other", null)).toBeNull();
    expect(describeLossOutcome("loss-confirmed", "succeeded")).toContain("退款已成功退回");
    expect(describeLossOutcome("loss-confirmed", "failed")).toContain("退款待辦");
    expect(describeLossOutcome("loss-confirmed", null)).toContain("尚未登記");
  });
});
