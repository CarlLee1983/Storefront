import { describe, expect, it } from "vitest";
import { describeShipFailure, parseStatusFilter, shipFormToInput } from "./order-form";

describe("parseStatusFilter", () => {
  it.each(["pending_payment", "paid", "partially_shipped", "shipped", "expired", "cancelled"])("%s 是有效的篩選", (status) => {
    expect(parseStatusFilter(status)).toBe(status);
  });

  it.each([[null], [""], ["all"], ["mystery"], ["PAID"]])("%s 視為不篩選", (value) => {
    expect(parseStatusFilter(value)).toBeUndefined();
  });
});

describe("shipFormToInput", () => {
  it("帶入訂單編號、冪等鍵、物流單號原文（trim 與長度由 App 驗證）與各明細數量；0 與留空的明細不送", () => {
    const form = new FormData();
    form.set("dispatchKey", "key-1");
    form.set("trackingNumber", "  TW123  ");
    form.set("quantity-11", "2");
    form.set("quantity-12", "0");
    form.set("quantity-13", "");

    expect(shipFormToInput(form, 7)).toEqual({ orderId: 7, dispatchKey: "key-1", items: [{ orderLineId: 11, quantity: 2 }], trackingNumber: "  TW123  ", appointment: undefined });
  });

  it("物流單號可以留空：欄位不存在或空字串都送出空字串", () => {
    const empty = new FormData();
    empty.set("trackingNumber", "");

    expect(shipFormToInput(empty, 7)).toMatchObject({ trackingNumber: "" });
    expect(shipFormToInput(new FormData(), 7)).toMatchObject({ trackingNumber: "", items: [] });
  });

  it("負數與非數字的數量原樣送出，由 App 回報欄位錯誤", () => {
    const form = new FormData();
    form.set("quantity-1", "-1");
    form.set("quantity-2", "abc");

    const { items } = shipFormToInput(form, 7);

    expect(items[0]).toEqual({ orderLineId: 1, quantity: -1 });
    expect(items[1]).toMatchObject({ orderLineId: 2 });
    expect(items[1]!.quantity).toBeNaN();
  });

  it("議定時段以台北時間解讀（UTC+8）；兩欄都留空為沒有，只填一欄或格式不對時另一欄為 NaN 由 App 拒絕", () => {
    const form = new FormData();
    form.set("appointmentStart", "2026-10-10T09:00");
    form.set("appointmentEnd", "2026-10-10T12:00");
    expect(shipFormToInput(form, 7).appointment).toEqual({ start: Date.UTC(2026, 9, 10, 1, 0), end: Date.UTC(2026, 9, 10, 4, 0) });

    const half = new FormData();
    half.set("appointmentStart", "2026-10-10T09:00");
    expect(shipFormToInput(half, 7).appointment!.end).toBeNaN();

    const bad = new FormData();
    bad.set("appointmentStart", "tomorrow");
    bad.set("appointmentEnd", "2026-10-10T12:00");
    expect(shipFormToInput(bad, 7).appointment!.start).toBeNaN();
  });
});

describe("describeShipFailure", () => {
  it("不能交運、找不到訂單、數量超過、時段缺漏各有專屬訊息", () => {
    expect(describeShipFailure({ reason: "order_not_shippable" }).message).toContain("不是已付款或部分出貨");
    expect(describeShipFailure({ reason: "order_not_found" }).message).toBe("找不到這張訂單");
    expect(describeShipFailure({ reason: "shipment_quantity_exceeded" }).message).toContain("尚未交運的數量");
    expect(describeShipFailure({ reason: "dispatch_key_conflict" }).message).toContain("重新整理");
    expect(describeShipFailure({ reason: "appointment_required" }).message).toContain("配送時段");
    expect(describeShipFailure({ reason: "appointment_not_applicable" }).message).toContain("不需要配送時段");
  });

  it("輸入有誤時帶回欄位錯誤，其他原因用預設訊息", () => {
    expect(describeShipFailure({ reason: "invalid_input", fields: { trackingNumber: ["物流單號不可超過 100 個字"] } })).toEqual({
      message: "輸入有誤，請修正後再送出",
      fields: { trackingNumber: ["物流單號不可超過 100 個字"] },
    });
    expect(describeShipFailure({ reason: "boom" })).toEqual({ message: "交運失敗，請稍後再試", fields: {} });
  });
});
