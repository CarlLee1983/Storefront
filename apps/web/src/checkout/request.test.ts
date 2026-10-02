import { describe, expect, it } from "vitest";
import { addToCart, emptyCart } from "../cart/cart";
import { cartToCheckoutLines, checkoutFingerprint, checkoutFormToInput } from "./request";

const cart = addToCart(
  addToCart(emptyCart, { variantId: 1, productId: 1, name: "馬克杯", unitPriceTwd: 320 }, 2),
  { variantId: 7, productId: 7, name: "原子筆", unitPriceTwd: 45 },
  3,
);

describe("cartToCheckoutLines（購物車 → 結帳明細）", () => {
  it("每筆帶商品、數量與加入時看到的單價，不帶名稱", () => {
    expect(cartToCheckoutLines(cart)).toEqual([
      { variantId: 1, quantity: 2, seenUnitPriceTwd: 320 },
      { variantId: 7, quantity: 3, seenUnitPriceTwd: 45 },
    ]);
  });

  it("空購物車回空清單", () => {
    expect(cartToCheckoutLines(emptyCart)).toEqual([]);
  });
});

function formOf(fields: Record<string, string>): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return form;
}

describe("checkoutFormToInput（結帳表單 → RPC 輸入）", () => {
  const lines = [{ variantId: 1, quantity: 2, seenUnitPriceTwd: 320 }];

  it("組出明細、收件資訊與冪等鍵", () => {
    const form = formOf({
      lines: JSON.stringify(lines),
      name: "王小明",
      phone: "0912345678",
      address: "台北市",
      idempotencyKey: "key-key-key-key-key",
    });

    expect(checkoutFormToInput(form)).toEqual({
      lines,
      shippingInfo: { name: "王小明", phone: "0912345678", address: "台北市" },
      idempotencyKey: "key-key-key-key-key",
    });
  });

  it("欄位缺漏時轉成空字串，是否合法交給 App 驗證", () => {
    expect(checkoutFormToInput(formOf({ lines: "[]" }))).toEqual({
      lines: [],
      shippingInfo: { name: "", phone: "", address: "" },
      idempotencyKey: "",
    });
  });

  it.each([["不是 JSON", "{oops"], ["沒有這個欄位", null]])("明細%s時 lines 為 null，由 App 回報輸入有誤", (_label, raw) => {
    const form = raw === null ? new FormData() : formOf({ lines: raw });
    expect(checkoutFormToInput(form).lines).toBeNull();
  });
});

describe("checkoutFingerprint（結帳內容指紋）", () => {
  const lines = [{ variantId: 1, quantity: 2, seenUnitPriceTwd: 320 }];
  const shipping = { name: "王小明", phone: "0912", address: "台北" };

  it("同樣的明細與收件資訊得到同樣的指紋", () => {
    expect(checkoutFingerprint(lines, shipping)).toBe(checkoutFingerprint([...lines], { ...shipping }));
  });

  it.each([
    ["數量", [{ ...lines[0]!, quantity: 3 }], shipping],
    ["單價", [{ ...lines[0]!, seenUnitPriceTwd: 350 }], shipping],
    ["地址", lines, { ...shipping, address: "高雄" }],
  ])("%s不同，指紋就不同", (_label, otherLines, otherShipping) => {
    expect(checkoutFingerprint(otherLines, otherShipping)).not.toBe(checkoutFingerprint(lines, shipping));
  });

  it("收件資訊前後空白不影響（App 會 trim）", () => {
    expect(checkoutFingerprint(lines, { ...shipping, name: " 王小明 " })).toBe(checkoutFingerprint(lines, shipping));
  });
});
