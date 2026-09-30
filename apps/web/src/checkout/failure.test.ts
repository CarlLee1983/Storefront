import { describe, expect, it } from "vitest";
import { addToCart, emptyCart } from "../cart/cart";
import { applyPriceChanges, describeCheckoutFailure, describeIssue, removeLines, type CheckoutIssue } from "./failure";

const cart = [
  { productId: 1, name: "馬克杯", unitPriceTwd: 320 },
  { productId: 2, name: "原子筆", unitPriceTwd: 45 },
  { productId: 3, name: "帆布袋", unitPriceTwd: 200 },
].reduce((current, item) => addToCart(current, item, 2), emptyCart);

describe("describeIssue（逐筆原因 → 提示文字）", () => {
  it("價格變動：顯示新價格與原本看到的價格", () => {
    const issue: CheckoutIssue = { productId: 1, kind: "price_changed", currentUnitPriceTwd: 350 };
    expect(describeIssue(issue, cart.lines[0])).toBe("「馬克杯」的單價已變動為 NT$ 350（你看到的是 NT$ 320）。");
  });

  it("已下架、可售數量不足、商品不存在：提示移除或改數量，不帶數字", () => {
    expect(describeIssue({ productId: 1, kind: "unlisted" }, cart.lines[0])).toBe("「馬克杯」已下架，無法結帳，請移除。");
    expect(describeIssue({ productId: 1, kind: "insufficient_stock" }, cart.lines[0])).toBe(
      "「馬克杯」的可售數量不足，請減少數量或移除。",
    );
    expect(describeIssue({ productId: 1, kind: "product_not_found" }, cart.lines[0])).toBe("「馬克杯」已不存在，請移除。");
  });

  it("購物車裡找不到那一筆時用商品編號代替名稱", () => {
    expect(describeIssue({ productId: 9, kind: "unlisted" }, undefined)).toBe("「商品 #9」已下架，無法結帳，請移除。");
  });
});

describe("applyPriceChanges（更新購物車為新價格）", () => {
  it("只改有價格變動的那幾筆的單價，數量與其他筆不變", () => {
    const issues: CheckoutIssue[] = [
      { productId: 1, kind: "price_changed", currentUnitPriceTwd: 350 },
      { productId: 2, kind: "unlisted" },
    ];

    expect(applyPriceChanges(cart, issues).lines).toEqual([
      { productId: 1, name: "馬克杯", unitPriceTwd: 350, quantity: 2 },
      { productId: 2, name: "原子筆", unitPriceTwd: 45, quantity: 2 },
      { productId: 3, name: "帆布袋", unitPriceTwd: 200, quantity: 2 },
    ]);
  });

  it("沒有價格變動時回傳原購物車", () => {
    expect(applyPriceChanges(cart, [{ productId: 2, kind: "unlisted" }])).toBe(cart);
  });

  it("新價格不是正整數（不該發生）就不採用", () => {
    expect(applyPriceChanges(cart, [{ productId: 1, kind: "price_changed", currentUnitPriceTwd: 0 }])).toBe(cart);
  });
});

describe("removeLines", () => {
  it("移除指定商品，其他不變", () => {
    expect(removeLines(cart, [1, 3]).lines.map((line) => line.productId)).toEqual([2]);
  });
});

describe("describeCheckoutFailure（RPC 失敗結果 → 頁面訊息）", () => {
  it("被拒：帶逐筆問題清單", () => {
    const issues: CheckoutIssue[] = [{ productId: 1, kind: "unlisted" }];
    expect(describeCheckoutFailure({ reason: "checkout_rejected", issues })).toEqual({
      message: "有商品無法結帳，請依下列說明修正後再送出。",
      fields: {},
      issues,
    });
  });

  it("輸入有誤：帶欄位錯誤（訊息來自 App）", () => {
    expect(describeCheckoutFailure({ reason: "invalid_input", fields: { shippingInfo: ["收件地址不可為空"] } })).toEqual({
      message: "輸入有誤，請修正後再送出。",
      fields: { shippingInfo: ["收件地址不可為空"] },
      issues: [],
    });
  });

  it("冪等鍵帶了不同內容：請顧客重新送出（頁面會換新鍵）", () => {
    expect(describeCheckoutFailure({ reason: "idempotency_key_reused" })).toEqual({
      message: "這次結帳的內容和先前送出的不同，已重新準備，請確認內容後再送出一次。",
      fields: {},
      issues: [],
    });
  });

  it("暫時無法完成結帳（診斷不出原因）", () => {
    expect(describeCheckoutFailure({ reason: "checkout_unavailable" })).toEqual({
      message: "目前無法完成結帳，請稍後再試。",
      fields: {},
      issues: [],
    });
  });

  it("其他原因：通用訊息", () => {
    expect(describeCheckoutFailure({ reason: "whatever" })).toEqual({
      message: "結帳失敗，請稍後再試。",
      fields: {},
      issues: [],
    });
  });
});
