import { describe, expect, it } from "vitest";
import { cancellableQuantity, cancellationFormToInput, cancellationStatusLabel, customerCancellationNote, describeCancellationFailure } from "./cancellation";

describe("cancellationFormToInput", () => {
  it("帶入訂單編號、冪等鍵、原因原文（trim 與長度由 App 驗證）與各明細數量；0 與留空的明細不送", () => {
    const form = new FormData();
    form.set("requestKey", "key-1");
    form.set("reason", "  買重複  ");
    form.set("cancel-11", "2");
    form.set("cancel-12", "0");
    form.set("cancel-13", "");
    form.set("other", "9");

    expect(cancellationFormToInput(form, 7)).toEqual({ orderId: 7, requestKey: "key-1", items: [{ orderLineId: 11, quantity: 2 }], reason: "  買重複  " });
  });

  it("負數與非數字的數量原樣送出，由 App 回報欄位錯誤", () => {
    const form = new FormData();
    form.set("cancel-1", "-1");
    form.set("cancel-2", "abc");

    const { items } = cancellationFormToInput(form, 7);

    expect(items[0]).toEqual({ orderLineId: 1, quantity: -1 });
    expect(items[1]!.orderLineId).toBe(2);
    expect(Number.isNaN(items[1]!.quantity)).toBe(true);
  });
});

describe("cancellableQuantity", () => {
  it("扣掉已交運、已核准取消與待審占用的數量，不為負", () => {
    expect(cancellableQuantity({ quantity: 5, shippedQuantity: 1, cancelledQuantity: 1, pendingCancellationQuantity: 2 })).toBe(1);
    expect(cancellableQuantity({ quantity: 1, shippedQuantity: 1, cancelledQuantity: 1, pendingCancellationQuantity: 1 })).toBe(0);
  });
});

describe("顯示文字", () => {
  it("不認得的狀態不顯示原始代碼", () => {
    expect(cancellationStatusLabel("approved")).toBe("已核准");
    expect(cancellationStatusLabel("mystery")).toBe("狀態待確認");
    expect(customerCancellationNote("mystery")).not.toContain("mystery");
  });

  it("失敗原因有對應訊息，未知原因給通用訊息並保留欄位錯誤", () => {
    expect(describeCancellationFailure({ reason: "cancellation_quantity_exceeded" }).message).toContain("數量超過");
    expect(describeCancellationFailure({ reason: "boom", fields: { items: ["x"] } })).toEqual({ message: "申請取消失敗，請稍後再試", fields: { items: ["x"] } });
  });
});
