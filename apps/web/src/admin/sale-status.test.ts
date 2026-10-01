import { describe, expect, it } from "vitest";
import { saleStatusText } from "./sale-status";

describe("saleStatusText", () => {
  it("沒有原價：不是特價", () => {
    expect(saleStatusText(true, null)).toBe("—");
    expect(saleStatusText(false, null)).toBe("—");
  });

  it("上架中且有原價：特價，附原價", () => {
    expect(saleStatusText(true, 1450)).toBe("特價（原價 NT$ 1,450）");
  });

  it("下架中但有原價：說明前台不顯示，不稱為特價", () => {
    expect(saleStatusText(false, 450)).toBe("原價 NT$ 450（下架中，前台不顯示）");
  });
});
