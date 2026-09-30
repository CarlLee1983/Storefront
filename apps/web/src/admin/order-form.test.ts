import { describe, expect, it } from "vitest";
import { describeShipFailure, parseStatusFilter, shipFormToInput } from "./order-form";

describe("parseStatusFilter", () => {
  it.each(["pending_payment", "paid", "shipped", "expired", "cancelled"])("%s 是有效的篩選", (status) => {
    expect(parseStatusFilter(status)).toBe(status);
  });

  it.each([[null], [""], ["all"], ["mystery"], ["PAID"]])("%s 視為不篩選", (value) => {
    expect(parseStatusFilter(value)).toBeUndefined();
  });
});

describe("shipFormToInput", () => {
  it("帶入訂單編號與物流單號原文（trim 與長度由 App 驗證）", () => {
    const form = new FormData();
    form.set("trackingNumber", "  TW123  ");

    expect(shipFormToInput(form, 7)).toEqual({ orderId: 7, trackingNumber: "  TW123  " });
  });

  it("物流單號可以留空：欄位不存在或空字串都送出空字串", () => {
    const empty = new FormData();
    empty.set("trackingNumber", "");

    expect(shipFormToInput(empty, 7)).toEqual({ orderId: 7, trackingNumber: "" });
    expect(shipFormToInput(new FormData(), 7)).toEqual({ orderId: 7, trackingNumber: "" });
  });
});

describe("describeShipFailure", () => {
  it("非已付款、找不到訂單各有專屬訊息", () => {
    expect(describeShipFailure({ reason: "order_not_shippable" }).message).toBe("這張訂單目前不是已付款，不能出貨（可能已出貨或已被處理）");
    expect(describeShipFailure({ reason: "order_not_found" }).message).toBe("找不到這張訂單");
  });

  it("輸入有誤時帶回欄位錯誤，其他原因用預設訊息", () => {
    expect(describeShipFailure({ reason: "invalid_input", fields: { trackingNumber: ["物流單號不可超過 100 個字"] } })).toEqual({
      message: "輸入有誤，請修正後再送出",
      fields: { trackingNumber: ["物流單號不可超過 100 個字"] },
    });
    expect(describeShipFailure({ reason: "boom" })).toEqual({ message: "出貨失敗，請稍後再試", fields: {} });
  });
});
