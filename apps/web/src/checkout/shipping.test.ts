import { describe, expect, it } from "vitest";
import { addToCart, emptyCart } from "../cart/cart";
import { cartShippingFees, parseShippingQuote, shippingQuoteUrl } from "./shipping";

const rates = { standard: 100, large: 600 };
const quote = { rates, variants: [{ variantId: 1, deliveryType: "standard" as const }, { variantId: 2, deliveryType: "standard" as const }, { variantId: 3, deliveryType: "large" as const }] };
const item = (variantId: number) => ({ variantId, productId: variantId, name: `商品${variantId}`, unitPriceTwd: 100 });
const cartOf = (...ids: number[]) => ids.reduce((cart, id) => addToCart(cart, item(id), 2), emptyCart);

describe("cartShippingFees（購物車運費）", () => {
  it("同類多筆多件只收一次", () => {
    expect(cartShippingFees(cartOf(1, 2), quote)).toEqual({ standard: 100, large: 0, totalTwd: 100 });
  });

  it("只有大型配送收大型運費", () => {
    expect(cartShippingFees(cartOf(3), quote)).toEqual({ standard: 0, large: 600, totalTwd: 600 });
  });

  it("混合兩類各收一次", () => {
    expect(cartShippingFees(cartOf(1, 3), quote)).toEqual({ standard: 100, large: 600, totalTwd: 700 });
  });

  it("空購物車或查不到類型的變體不計運費", () => {
    expect(cartShippingFees(emptyCart, quote).totalTwd).toBe(0);
    expect(cartShippingFees(cartOf(99), quote).totalTwd).toBe(0);
  });
});

describe("parseShippingQuote", () => {
  it("接受 App 的回傳形狀", () => {
    expect(parseShippingQuote(quote)).toEqual(quote);
  });

  it.each([
    ["不是物件", null],
    ["缺費率", { variants: [] }],
    ["費率為負", { rates: { standard: -1, large: 600 }, variants: [] }],
    ["費率不是整數", { rates: { standard: 1.5, large: 600 }, variants: [] }],
    ["未知的配送類型", { rates, variants: [{ variantId: 1, deliveryType: "express" }] }],
  ])("%s回 null", (_label, raw) => {
    expect(parseShippingQuote(raw)).toBeNull();
  });
});

it("shippingQuoteUrl 帶出購物車所有變體編號", () => {
  expect(shippingQuoteUrl(cartOf(1, 3))).toBe("/api/shipping-quote?variants=1,3");
});
