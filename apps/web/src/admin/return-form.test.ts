import { describe, expect, it } from "vitest";
import { describeReturnFailure, describeReturnOutcome, inspectionFormToInput, receiptFormToInput, scrapFormToInput } from "./return-form";

describe("receiptFormToInput", () => {
  it("每筆明細一個欄位，帶入申請編號與備註原文", () => {
    const form = new FormData();
    form.set("requestId", "5");
    form.set("note", " 外箱完好 ");
    form.set("received-11", "2");
    form.set("received-12", "0");
    form.set("other", "9");

    expect(receiptFormToInput(form)).toEqual({ requestId: 5, items: [{ orderLineId: 11, receivedQuantity: 2 }, { orderLineId: 12, receivedQuantity: 0 }], note: " 外箱完好 " });
  });

  it("留空的數量送出 NaN，由 App 回報錯誤", () => {
    const form = new FormData();
    form.set("received-1", "");

    expect(Number.isNaN(receiptFormToInput(form).items[0]!.receivedQuantity)).toBe(true);
  });
});

describe("inspectionFormToInput", () => {
  it("良品與損壞品依明細編號配對；缺損壞欄位送出 NaN", () => {
    const form = new FormData();
    form.set("requestId", "5");
    form.set("sellable-11", "1");
    form.set("damaged-11", "1");
    form.set("sellable-12", "2");

    const input = inspectionFormToInput(form);

    expect(input.items[0]).toEqual({ orderLineId: 11, sellableQuantity: 1, damagedQuantity: 1 });
    expect(Number.isNaN(input.items[1]!.damagedQuantity)).toBe(true);
  });
});

describe("scrapFormToInput", () => {
  it("帶入變體、數量與原因原文", () => {
    const form = new FormData();
    form.set("variantId", "3");
    form.set("quantity", "2");
    form.set("reason", "損壞");

    expect(scrapFormToInput(form)).toEqual({ variantId: 3, quantity: 2, reason: "損壞" });
  });
});

describe("訊息", () => {
  it("失敗依原因；不認得的用通用說明", () => {
    expect(describeReturnFailure({ reason: "insufficient_unavailable" }).message).toContain("損壞品");
    expect(describeReturnFailure({ reason: "zzz" }).message).toBe("操作失敗，請稍後再試");
  });

  it("成功提示：檢查完成時依退款進度分文案，不認得的 saved 回 null", () => {
    expect(describeReturnOutcome("return-approved", null)).toContain("核准");
    expect(describeReturnOutcome("return-inspected", "succeeded")).toContain("退款已成功退回");
    expect(describeReturnOutcome("return-inspected", "failed")).toContain("不影響已發生的庫存變動");
    expect(describeReturnOutcome("return-inspected", "none")).toContain("尚未登記");
    expect(describeReturnOutcome("x", null)).toBeNull();
  });
});
