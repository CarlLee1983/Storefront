import { describe, expect, it, vi } from "vitest";
import { addToCart, emptyCart, type Cart } from "./cart";
import { INVALID_QUANTITY_MESSAGE, SAVE_FAILED_MESSAGE, addFeedback } from "./feedback";

const mug = { variantId: 1, productId: 1, name: "馬克杯", unitPriceTwd: 320 };
const inCart = addToCart(emptyCart, mug, 2);
const outcome = (cart: Cart, saved = true) => vi.fn(() => ({ cart, saved }));

describe("addFeedback", () => {
  it("加入成功：顯示已加入與該商品目前的件數", () => {
    expect(addFeedback(1, mug.variantId, outcome(inCart))).toBe("已加入購物車，目前 2 件。");
  });

  it.each([0, -1, 1.5, Number.NaN])("數量 %s 無效：顯示數量錯誤，且不執行加入", (quantity) => {
    const add = outcome(inCart);
    expect(addFeedback(quantity, mug.variantId, add)).toBe(INVALID_QUANTITY_MESSAGE);
    expect(add).not.toHaveBeenCalled();
  });

  it("商品已在車內又輸入無效數量：不顯示已加入", () => {
    expect(addFeedback(0, mug.variantId, outcome(inCart))).not.toContain("已加入");
  });

  it("沒能存進瀏覽器：顯示變更未能儲存", () => {
    expect(addFeedback(1, mug.variantId, outcome(inCart, false))).toBe(SAVE_FAILED_MESSAGE);
    expect(SAVE_FAILED_MESSAGE).toContain("未能儲存");
  });

  it("商品資料被拒絕（車內沒有這件商品）：不顯示已加入", () => {
    expect(addFeedback(1, 99, outcome(inCart))).toBe("目前無法加入這件商品，請重新整理後再試。");
  });
});
