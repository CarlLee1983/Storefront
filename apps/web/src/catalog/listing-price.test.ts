import { describe, expect, it } from "vitest";
import { cardPrice } from "./listing-price";

const plain = { hasOptions: false, priceTwd: 320, maxPriceTwd: 320, compareAtPriceTwd: null, onSale: false };

describe("cardPrice", () => {
  it("沒有選項的商品顯示單一價格", () => {
    expect(cardPrice(plain)).toEqual({ text: "NT$ 320", sale: null, hasSaleOption: false });
  });

  it("沒有選項的特價商品帶劃線價與折扣", () => {
    expect(cardPrice({ ...plain, priceTwd: 300, maxPriceTwd: 300, compareAtPriceTwd: 400, onSale: true }).sale).toMatchObject({ compareAtTwd: 400, badge: "−25%" });
  });

  it("有選項且價格不同顯示範圍；價格相同只顯示一個", () => {
    expect(cardPrice({ ...plain, hasOptions: true, priceTwd: 9000, maxPriceTwd: 12000 }).text).toBe("NT$ 9,000 – NT$ 12,000");
    expect(cardPrice({ ...plain, hasOptions: true, priceTwd: 9000, maxPriceTwd: 9000 }).text).toBe("NT$ 9,000");
  });

  it("有選項且有特價變體：標示有特價選項，不顯示單一劃線價", () => {
    expect(cardPrice({ ...plain, hasOptions: true, priceTwd: 9000, maxPriceTwd: 12000, onSale: true })).toMatchObject({ sale: null, hasSaleOption: true });
  });

  it("全部變體停賣：沒有報價", () => {
    expect(cardPrice({ ...plain, priceTwd: null, maxPriceTwd: null })).toEqual({ text: null, sale: null, hasSaleOption: false });
  });
});
