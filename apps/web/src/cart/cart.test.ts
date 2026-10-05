import { describe, expect, it } from "vitest";
import { CART_VERSION, MAX_QUANTITY, addToCart, cartCount, cartTotal, deserializeCart, emptyCart, lineSubtotal, removeFromCart, serializeCart, setQuantity } from "./cart";

const mug = { variantId: 1, productId: 1, name: "馬克杯", unitPriceTwd: 320 };

describe("addToCart", () => {
  it.each([
    ["variantId 是 NaN", { ...mug, variantId: Number.NaN }],
    ["productId 是 0", { ...mug, variantId: 0, productId: 0 }],
    ["單價是 0", { ...mug, unitPriceTwd: 0 }],
    ["單價是小數", { ...mug, unitPriceTwd: 1.5 }],
    ["單價是負數", { ...mug, unitPriceTwd: -5 }],
    ["單價超出 safe integer", { ...mug, unitPriceTwd: 2 ** 60 }],
    ["單價是 NaN", { ...mug, unitPriceTwd: Number.NaN }],
  ])("商品資料不合格（%s）：拒絕，購物車不變", (_label, item) => {
    const before = addToCart(emptyCart, mug, 1);
    expect(addToCart(before, item, 1)).toBe(before);
  });

  it("空購物車加入商品：多一筆，記住加入當下的名稱與單價", () => {
    const cart = addToCart(emptyCart, mug, 2);
    expect(cart.lines).toEqual([{ variantId: 1, productId: 1, name: "馬克杯", unitPriceTwd: 320, quantity: 2 }]);
  });

  it("同一商品再次加入：數量相加，名稱與單價以最新加入時看到的為準", () => {
    const first = addToCart(emptyCart, mug, 2);
    const cart = addToCart(first, { variantId: 1, productId: 1, name: "馬克杯（新款）", unitPriceTwd: 350 }, 3);
    expect(cart.lines).toEqual([{ variantId: 1, productId: 1, name: "馬克杯（新款）", unitPriceTwd: 350, quantity: 5 }]);
  });

  it("不同商品各自一筆，維持加入順序", () => {
    const cart = addToCart(addToCart(emptyCart, mug, 1), { variantId: 2, productId: 2, name: "杯墊", unitPriceTwd: 80 }, 1);
    expect(cart.lines.map((l) => l.variantId)).toEqual([1, 2]);
  });

  it("不改動傳入的購物車", () => {
    const before = addToCart(emptyCart, mug, 1);
    addToCart(before, mug, 1);
    expect(before.lines[0]?.quantity).toBe(1);
  });

  it("超過可售數量時整次拒絕，包括重複加入", () => {
    expect(addToCart(emptyCart, mug, 5, 4)).toBe(emptyCart);
    const before = addToCart(emptyCart, mug, 3);
    expect(addToCart(before, { ...mug, unitPriceTwd: 999 }, 2, 4)).toBe(before);
    expect(addToCart(before, mug, 1, 4).lines[0]?.quantity).toBe(4);
  });

  it("超過通用上限同樣整次拒絕", () => {
    expect(addToCart(emptyCart, mug, 500)).toBe(emptyCart);
    const before = addToCart(emptyCart, mug, 98);
    expect(addToCart(before, mug, 2, 100)).toBe(before);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("數量 %s 不是正整數：拒絕，購物車不變", (quantity) => {
    const before = addToCart(emptyCart, mug, 2);
    expect(addToCart(before, mug, quantity)).toBe(before);
  });
});

const twoLines = addToCart(addToCart(emptyCart, mug, 2), { variantId: 2, productId: 2, name: "杯墊", unitPriceTwd: 80 }, 1);

describe("setQuantity", () => {
  it("把該筆數量改成指定值，單價與其他筆不變", () => {
    const cart = setQuantity(twoLines, 1, 7);
    expect(cart.lines).toEqual([
      { variantId: 1, productId: 1, name: "馬克杯", unitPriceTwd: 320, quantity: 7 },
      { variantId: 2, productId: 2, name: "杯墊", unitPriceTwd: 80, quantity: 1 },
    ]);
  });

  it("超過上限拒絕", () => {
    expect(setQuantity(twoLines, 1, 1000)).toBe(twoLines);
  });

  it.each([0, -3, 2.5, Number.NaN])("數量 %s 不是正整數：拒絕，購物車不變", (quantity) => {
    expect(setQuantity(twoLines, 1, quantity)).toBe(twoLines);
  });

  it("車內沒有該商品：購物車不變", () => {
    expect(setQuantity(twoLines, 99, 3)).toBe(twoLines);
  });
});

describe("removeFromCart", () => {
  it("移除該筆，其他筆保留", () => {
    expect(removeFromCart(twoLines, 1).lines.map((l) => l.variantId)).toEqual([2]);
  });

  it("車內沒有該商品：內容不變", () => {
    expect(removeFromCart(twoLines, 99).lines).toEqual(twoLines.lines);
  });
});

describe("小計、總額與購物車筆數", () => {
  it("小計是加入時單價 × 數量", () => {
    expect(lineSubtotal({ variantId: 1, productId: 1, name: "馬克杯", unitPriceTwd: 320, quantity: 3 })).toBe(960);
  });

  it("總額是各筆小計加總；購物車數字只算不同商品變體的筆數", () => {
    expect(cartTotal(twoLines)).toBe(2 * 320 + 80);
    expect(cartCount(addToCart(emptyCart, mug, 3))).toBe(1);
    expect(cartCount(twoLines)).toBe(2);
  });

  it("空購物車：總額與筆數為 0", () => {
    expect(cartTotal(emptyCart)).toBe(0);
    expect(cartCount(emptyCart)).toBe(0);
  });
});

describe("serializeCart / deserializeCart", () => {
  it("序列化後可還原成相同內容，格式帶版本欄位", () => {
    const json = serializeCart(twoLines);
    expect(JSON.parse(json).version).toBe(CART_VERSION);
    expect(deserializeCart(json)).toEqual(twoLines);
  });

  it("空購物車來回不變", () => {
    expect(deserializeCart(serializeCart(emptyCart))).toEqual(emptyCart);
  });

  it.each([
    ["null（沒有存過）", null],
    ["空字串", ""],
    ["不是 JSON", "{oops"],
    ["JSON 但不是物件", "[]"],
    ["版本不符", JSON.stringify({ version: 999, lines: [] })],
    ["舊版（以商品編號為單位的第 1 版）", JSON.stringify({ version: 1, lines: [{ productId: 1, name: "馬克杯", unitPriceTwd: 320, quantity: 1 }] })],
    ["沒有版本", JSON.stringify({ lines: [] })],
    ["lines 不是陣列", JSON.stringify({ version: CART_VERSION, lines: {} })],
  ])("%s：視為空購物車", (_label, raw) => {
    expect(deserializeCart(raw)).toEqual(emptyCart);
  });

  const line = { variantId: 1, productId: 1, name: "馬克杯", unitPriceTwd: 320, quantity: 2 };
  it.each([
    ["productId 不是正整數", { ...line, variantId: 0, productId: 0 }],
    ["name 不是字串", { ...line, name: 5 }],
    ["單價是小數", { ...line, unitPriceTwd: 1.5 }],
    ["單價是負數", { ...line, unitPriceTwd: -1 }],
    ["單價是 0", { ...line, unitPriceTwd: 0 }],
    ["單價超出 safe integer", { ...line, unitPriceTwd: 2 ** 60 }],
    ["單價是字串", { ...line, unitPriceTwd: "320" }],
    ["數量是 0", { ...line, quantity: 0 }],
    ["數量超過上限", { ...line, quantity: MAX_QUANTITY + 1 }],
    ["數量是小數", { ...line, quantity: 1.5 }],
    ["該筆不是物件", null],
  ])("有一筆 %s：整份視為空購物車", (_label, bad) => {
    const raw = JSON.stringify({ version: CART_VERSION, lines: [line, bad] });
    expect(deserializeCart(raw)).toEqual(emptyCart);
  });

  it("同一商品出現兩筆：視為損壞", () => {
    const raw = JSON.stringify({ version: CART_VERSION, lines: [line, line] });
    expect(deserializeCart(raw)).toEqual(emptyCart);
  });

  it("多餘的欄位被丟棄，只留已知欄位", () => {
    const raw = JSON.stringify({ version: CART_VERSION, lines: [{ ...line, evil: "x" }] });
    expect(deserializeCart(raw).lines).toEqual([line]);
  });
});

describe("商品變體", () => {
  const table120 = { variantId: 10, productId: 3, name: "餐桌", label: "120 公分 / 胡桃色", unitPriceTwd: 9000 };
  const table150 = { variantId: 11, productId: 3, name: "餐桌", label: "150 公分 / 胡桃色", unitPriceTwd: 12000 };

  it("同商品的不同變體各佔一筆，不合併；同一變體再加入才合併並以最新選項標籤為準", () => {
    const cart = addToCart(addToCart(addToCart(emptyCart, table120, 1), table150, 2), { ...table120, label: "120 公分 / 白橡色" }, 1);
    expect(cart.lines).toEqual([
      { ...table120, label: "120 公分 / 白橡色", quantity: 2 },
      { ...table150, quantity: 2 },
    ]);
    expect(cartTotal(cart)).toBe(9000 * 2 + 12000 * 2);
  });

  it("選項標籤隨購物車序列化還原；沒有標籤的舊資料照舊可用", () => {
    const cart = addToCart(addToCart(emptyCart, table120, 1), mug, 1);
    expect(deserializeCart(serializeCart(cart))).toEqual(cart);
    expect(cart.lines[1]).not.toHaveProperty("label");
  });

  it("選項標籤不是字串：整份視為空購物車", () => {
    const raw = JSON.stringify({ version: CART_VERSION, lines: [{ ...table120, quantity: 1, label: 5 }] });
    expect(deserializeCart(raw)).toEqual(emptyCart);
  });
});
