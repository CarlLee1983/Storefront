import { describe, expect, it } from "vitest";
import { declareReturnFormToInput, describeShipmentReturnFailure, describeShipmentReturnOutcome, shipmentReturnInspectionFormToInput, shipmentReturnReceiptFormToInput } from "./shipment-return-form";

describe("declareReturnFormToInput", () => {
  it("每筆明細有退回與尋回兩個欄位，留空或 0 不算，兩者都沒有的明細不送，其餘欄位忽略", () => {
    const form = new FormData();
    form.set("shipmentId", "7");
    form.set("returnKey", "abc");
    form.set("note", " 物流退回單號 X ");
    form.set("returned-11", "2");
    form.set("found-11", "");
    form.set("returned-12", "");
    form.set("found-12", "1");
    form.set("returned-13", "0");
    form.set("found-13", "0");
    form.set("other", "9");

    expect(declareReturnFormToInput(form)).toEqual({
      shipmentId: 7,
      returnKey: "abc",
      items: [{ orderLineId: 11, quantity: 2, foundLostQuantity: 0 }, { orderLineId: 12, quantity: 0, foundLostQuantity: 1 }],
      note: " 物流退回單號 X ",
    });
  });

  it("非數字與負數原樣交給 App 驗證，沒填任何數量送出空清單", () => {
    const form = new FormData();
    form.set("returned-1", "-1");
    form.set("returned-2", "x");

    const input = declareReturnFormToInput(form);
    expect(input.items[0]).toEqual({ orderLineId: 1, quantity: -1, foundLostQuantity: 0 });
    expect(Number.isNaN(input.items[1]!.quantity)).toBe(true);
    expect(declareReturnFormToInput(new FormData()).items).toEqual([]);
  });
});

describe("shipmentReturnReceiptFormToInput", () => {
  it("每筆明細一個收到欄位；尋回的遺失品欄位沒有就是 0；留空送出 NaN", () => {
    const form = new FormData();
    form.set("returnId", "5");
    form.set("note", " 外箱完好 ");
    form.set("received-11", "2");
    form.set("receivedfound-11", "1");
    form.set("received-12", "");
    form.set("other", "9");

    const input = shipmentReturnReceiptFormToInput(form);

    expect(input).toMatchObject({ returnId: 5, note: " 外箱完好 ", items: [{ orderLineId: 11, receivedQuantity: 2, receivedFoundLostQuantity: 1 }, { orderLineId: 12, receivedFoundLostQuantity: 0 }] });
    expect(Number.isNaN(input.items[1]!.receivedQuantity)).toBe(true);
  });
});

describe("shipmentReturnInspectionFormToInput", () => {
  it("良品與損壞品依明細編號配對；缺損壞欄位送出 NaN", () => {
    const form = new FormData();
    form.set("returnId", "5");
    form.set("sellable-11", "1");
    form.set("damaged-11", "1");
    form.set("sellable-12", "2");

    const input = shipmentReturnInspectionFormToInput(form);

    expect(input.items[0]).toEqual({ orderLineId: 11, sellableQuantity: 1, damagedQuantity: 1 });
    expect(Number.isNaN(input.items[1]!.damagedQuantity)).toBe(true);
  });
});

describe("describeShipmentReturnFailure", () => {
  it("已知原因有專屬訊息，未知原因用通用訊息，不洩漏代碼", () => {
    expect(describeShipmentReturnFailure({ reason: "shipment_delivered" }).message).toContain("已經送達");
    expect(describeShipmentReturnFailure({ reason: "shipment_return_wrong_state" }).message).toContain("重新整理");
    expect(describeShipmentReturnFailure({ reason: "boom" }).message).not.toContain("boom");
    expect(describeShipmentReturnFailure({ reason: "invalid_input", fields: { items: ["至少要選一筆明細"] } }).fields).toEqual({ items: ["至少要選一筆明細"] });
  });
});

describe("describeShipmentReturnOutcome", () => {
  it("各步驟有提示，檢查完成依退款進度分文案，不認得的回 null", () => {
    expect(describeShipmentReturnOutcome("return-declared", null)).toContain("不動庫存與款項");
    expect(describeShipmentReturnOutcome("shipment-return-received", null)).toContain("待檢");
    expect(describeShipmentReturnOutcome("shipment-return-not-received", null)).toContain("結案");
    expect(describeShipmentReturnOutcome("shipment-return-inspected", "succeeded")).toContain("退款已成功");
    expect(describeShipmentReturnOutcome("shipment-return-inspected", "failed")).toContain("退款待辦");
    expect(describeShipmentReturnOutcome("shipment-return-inspected", "none")).toContain("沒有登記退款");
    expect(describeShipmentReturnOutcome("other", null)).toBeNull();
  });
});
