import { describe, expect, it } from "vitest";
import { customerShipmentReturnNote, shipmentReturnStatusLabel, customerReturnNote, returnBatchNote, describeReturnRequestFailure, returnFormToInput, returnStatusLabel, returnableQuantity, customerLossNote } from "./return";

describe("returnFormToInput", () => {
  it("帶入訂單編號、冪等鍵、原因原文與各明細數量；0 與留空的明細不送", () => {
    const form = new FormData();
    form.set("requestKey", "key-1");
    form.set("reason", "  尺寸不合  ");
    form.set("return-11", "2");
    form.set("return-12", "0");
    form.set("return-13", "");
    form.set("other", "9");

    expect(returnFormToInput(form, 7)).toEqual({ orderId: 7, requestKey: "key-1", items: [{ orderLineId: 11, quantity: 2 }], reason: "  尺寸不合  " });
  });

  it("逐批的欄位 return-<明細>-<批次> 帶出 shipmentId（自助申請）", () => {
    const form = new FormData();
    form.set("return-11-5", "2");
    form.set("return-11-6", "1");
    form.set("return-12-5", "");

    expect(returnFormToInput(form, 7).items).toEqual([{ orderLineId: 11, shipmentId: 5, quantity: 2 }, { orderLineId: 11, shipmentId: 6, quantity: 1 }]);
  });

  it("負數與非數字的數量原樣送出，由 App 回報欄位錯誤", () => {
    const form = new FormData();
    form.set("return-1", "-1");
    form.set("return-2", "abc");

    const { items } = returnFormToInput(form, 7);

    expect(items[0]).toEqual({ orderLineId: 1, quantity: -1 });
    expect(Number.isNaN(items[1]!.quantity)).toBe(true);
  });
});

describe("returnableQuantity", () => {
  it("已交運扣掉已退貨與進行中的，不會小於 0", () => {
    expect(returnableQuantity({ shippedQuantity: 3, returnedQuantity: 1, openReturnQuantity: 1, lostQuantity: 0, shipmentReturnedQuantity: 0 })).toBe(1);
    expect(returnableQuantity({ shippedQuantity: 0, returnedQuantity: 0, openReturnQuantity: 0, lostQuantity: 0, shipmentReturnedQuantity: 0 })).toBe(0);
    expect(returnableQuantity({ shippedQuantity: 1, returnedQuantity: 1, openReturnQuantity: 1, lostQuantity: 0, shipmentReturnedQuantity: 0 })).toBe(0);
    expect(returnableQuantity({ shippedQuantity: 3, returnedQuantity: 0, openReturnQuantity: 1, lostQuantity: 1, shipmentReturnedQuantity: 0 })).toBe(1);
  });
});

describe("標籤與說明", () => {
  it("六種進度各有名稱與顧客說明，不認得的不顯示原始代碼", () => {
    for (const status of ["pending", "approved", "rejected", "received", "not_received", "completed"]) {
      expect(returnStatusLabel(status)).not.toBe("狀態待確認");
      expect(customerReturnNote(status)).not.toContain("無法確認");
    }
    expect(customerReturnNote("completed", true)).toContain("退款進度");
    expect(customerReturnNote("completed", false)).toContain("客服會與你聯繫");
    expect(returnStatusLabel("weird")).toBe("狀態待確認");
    expect(customerReturnNote("weird")).toContain("無法確認");
  });

  it("失敗訊息依原因，不認得的用通用說明並帶回欄位錯誤", () => {
    expect(describeReturnRequestFailure({ reason: "return_quantity_exceeded" }).message).toContain("數量超過");
    expect(describeReturnRequestFailure({ reason: "nope", fields: { items: ["至少要選一筆明細"] } })).toEqual({ message: "申請退貨失敗，請稍後再試", fields: { items: ["至少要選一筆明細"] } });
  });
});

describe("returnBatchNote", () => {
  it("開放時顯示期限；逾期與未送達都指向人工受理，不是否決", () => {
    const windowEndsAt = Date.UTC(2026, 9, 18, 16, 0);
    expect(returnBatchNote({ state: "open", deliveredAt: 1, windowEndsAt })).toContain("可自助申請");
    expect(returnBatchNote({ state: "open", deliveredAt: 1, windowEndsAt })).toContain("23:59:59");
    expect(returnBatchNote({ state: "closed", deliveredAt: 1, windowEndsAt })).toContain("人工受理");
    expect(returnBatchNote({ state: "not_delivered", deliveredAt: null, windowEndsAt: null })).toContain("人工受理");
  });
});

describe("customerLossNote", () => {
  it("說明不補寄、重新下單；退款未登記時不承諾自動辦理", () => {
    expect(customerLossNote(true)).toContain("重新下單");
    expect(customerLossNote(true)).toContain("已依原實付單價辦理退款");
    expect(customerLossNote(false)).toContain("客服會與你聯繫");
    expect(customerLossNote(false)).not.toContain("已依原實付單價辦理退款");
    expect(customerLossNote(false, false)).not.toContain("客服會與你聯繫");
  });
});

describe("物流退回", () => {
  it("可退貨數量也扣掉被物流退回的", () => {
    expect(returnableQuantity({ shippedQuantity: 3, returnedQuantity: 0, openReturnQuantity: 0, lostQuantity: 0, shipmentReturnedQuantity: 2 })).toBe(1);
    expect(returnableQuantity({ shippedQuantity: 3, returnedQuantity: 1, openReturnQuantity: 0, lostQuantity: 1, shipmentReturnedQuantity: 2 })).toBe(0);
  });

  it("進度名稱不洩漏代碼", () => {
    expect(shipmentReturnStatusLabel("returning")).toContain("物流退回中");
    expect(shipmentReturnStatusLabel("completed")).toBe("已檢查完成");
    expect(shipmentReturnStatusLabel("boom")).toBe("狀態待確認");
  });

  it("顧客說明：不補寄、需再購買請重新下單；完成後依退款是否登記、是否有應退金額分文案", () => {
    expect(customerShipmentReturnNote("returning", false, false)).toContain("重新下單");
    expect(customerShipmentReturnNote("received", false, false)).toContain("正在檢查");
    expect(customerShipmentReturnNote("not_received", false, false)).toContain("已結案");
    expect(customerShipmentReturnNote("completed", true, true)).toContain("退款進度");
    expect(customerShipmentReturnNote("completed", false, true)).toContain("客服會與你聯繫");
    expect(customerShipmentReturnNote("completed", false, false)).toContain("沒有需要退款的金額");
    expect(customerShipmentReturnNote("boom", false, false)).not.toContain("boom");
  });
});
