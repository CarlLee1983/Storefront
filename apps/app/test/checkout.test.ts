import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkoutInput, createStockedListing, newKey, SHIPPING_INFO, type LineInput } from "./checkout-helpers";
import { signInCustomer } from "./customers";
import { mintAccessJwt } from "./access";
import { setNow } from "./clock";
import { resetDb } from "./db";
import { createOrderService } from "../src/orders/service";

const app = exports.default;

describe("結帳的權限", () => {
  beforeEach(resetDb);
  afterEach(() => vi.restoreAllMocks());

  it("沒有 session（空 cookie）被拒絕為 unauthorized，不成立訂單", async () => {
    const { variantId } = await createStockedListing("馬克杯", 320, 5);

    expect(await app.checkout("", checkoutInput([{ variantId, quantity: 1, seenUnitPriceTwd: 320 }]))).toEqual({
      ok: false,
      reason: "unauthorized",
    });
  });
});

const PAYMENT_WINDOW_MS = 15 * 60 * 1000;

describe("結帳成功", () => {
  beforeEach(resetDb);
  afterEach(() => vi.restoreAllMocks());

  it("成立一張待付款訂單：回傳訂單編號、總金額與付款期限（注入時間 + 15 分鐘），訂單明細帶單價快照", async () => {
    const mug = await createStockedListing("馬克杯", 320, 10);
    const pen = await createStockedListing("原子筆", 45, 10);
    const cookie = await signInCustomer("alice");
    const now = Date.now() + 60_000;
    setNow(now);

    const result = await app.checkout(
      cookie,
      checkoutInput([
        { variantId: mug.variantId, quantity: 2, seenUnitPriceTwd: 320 },
        { variantId: pen.variantId, quantity: 3, seenUnitPriceTwd: 45 },
      ]),
    );

    expect(result).toEqual({
      ok: true,
      data: { orderId: expect.any(Number), status: "pending_payment", totalTwd: 320 * 2 + 45 * 3 + 100, paymentDeadline: now + PAYMENT_WINDOW_MS },
    });
    if (!result.ok) return;
    expect(await app.getMyOrder(cookie, { orderId: result.data.orderId })).toEqual({
      ok: true,
      data: {
        id: result.data.orderId,
        status: "pending_payment",
        totalTwd: 875,
        shippingFees: { standard: 100, large: 0 },
        shippingInfo: SHIPPING_INFO,
        paymentDeadline: now + PAYMENT_WINDOW_MS,
        createdAt: now,
        lines: [
          { id: expect.any(Number), productId: mug.productId, variantId: mug.variantId, productName: "馬克杯", variantLabel: "", quantity: 2, unitPriceTwd: 320, deliveryType: "standard", shippedQuantity: 0, cancelledQuantity: 0, pendingCancellationQuantity: 0, returnedQuantity: 0, openReturnQuantity: 0, lostQuantity: 0, cover: expect.objectContaining({ id: expect.any(String), variants: expect.any(Array) }) },
          { id: expect.any(Number), productId: pen.productId, variantId: pen.variantId, productName: "原子筆", variantLabel: "", quantity: 3, unitPriceTwd: 45, deliveryType: "standard", shippedQuantity: 0, cancelledQuantity: 0, pendingCancellationQuantity: 0, returnedQuantity: 0, openReturnQuantity: 0, lostQuantity: 0, cover: expect.objectContaining({ id: expect.any(String), variants: expect.any(Array) }) },
        ],
        payments: [],
        refunds: [],
        cancellations: [],
        returns: [],
        losses: [],
        returnBatches: [],
        shipments: [],
      },
    });
  });
});

/** 顧客目前所有訂單的編號；被拒的結帳不該留下任何訂單。 */
async function orderIdsOf(cookie: string): Promise<number[]> {
  const listed = await app.listMyOrders(cookie);
  if (!listed.ok) throw new Error("列出訂單失敗");
  return listed.data.map((order) => order.id);
}

async function availableOf(productId: number): Promise<number> {
  const found = await app.getProductForAdmin(await mintAccessJwt(), { id: productId });
  if (!found.ok) throw new Error("讀取商品失敗");
  return found.data.available;
}

describe("訂單明細的單價快照", () => {
  beforeEach(resetDb);
  afterEach(() => vi.restoreAllMocks());

  it("之後商品改價，既有訂單的訂單明細與總金額不變", async () => {
    const mug = await createStockedListing("馬克杯", 320, 10);
    const cookie = await signInCustomer("alice");
    const placed = await app.checkout(cookie, checkoutInput([{ variantId: mug.variantId, quantity: 2, seenUnitPriceTwd: 320 }]));
    if (!placed.ok) throw new Error("結帳失敗");

    await app.updateProduct(await mintAccessJwt(), { id: mug.productId, name: "馬克杯", description: "新說明", priceTwd: 999 });

    expect(await app.getMyOrder(cookie, { orderId: placed.data.orderId })).toMatchObject({
      ok: true,
      data: { totalTwd: 740, lines: [{ id: expect.any(Number), productId: mug.productId, variantId: mug.variantId, unitPriceTwd: 320, quantity: 2 }] },
    });
  });
});

describe("訂單明細的商品名稱快照", () => {
  beforeEach(resetDb);
  afterEach(() => vi.restoreAllMocks());

  it("商品改名後，既有訂單的訂單明細仍顯示下單當時的名稱", async () => {
    const mug = await createStockedListing("馬克杯", 320, 10);
    const cookie = await signInCustomer("alice");
    const placed = await app.checkout(cookie, checkoutInput([{ variantId: mug.variantId, quantity: 1, seenUnitPriceTwd: 320 }]));
    if (!placed.ok) throw new Error("結帳失敗");

    await app.updateProduct(await mintAccessJwt(), { id: mug.productId, name: "大馬克杯", description: "說明", priceTwd: 320 });

    expect(await app.getMyOrder(cookie, { orderId: placed.data.orderId })).toMatchObject({
      ok: true,
      data: { lines: [{ id: expect.any(Number), productId: mug.productId, variantId: mug.variantId, productName: "馬克杯" }] },
    });
    expect(await app.listMyOrders(cookie)).toMatchObject({ ok: true, data: [{ lines: [{ productName: "馬克杯" }] }] });
  });
});

describe("結帳被拒：逐筆說明原因", () => {
  beforeEach(resetDb);
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ["漲價", 400],
    ["降價", 250],
  ])("單價%s：回 checkout_rejected 並附目前單價，不成立訂單", async (_label, currentPrice) => {
    const mug = await createStockedListing("馬克杯", 320, 10);
    const cookie = await signInCustomer("alice");
    await app.updateProduct(await mintAccessJwt(), { id: mug.productId, name: "馬克杯", description: "說明", priceTwd: currentPrice });

    expect(await app.checkout(cookie, checkoutInput([{ variantId: mug.variantId, quantity: 1, seenUnitPriceTwd: 320 }]))).toEqual({
      ok: false,
      reason: "checkout_rejected",
      issues: [{ variantId: mug.variantId, kind: "price_changed", currentUnitPriceTwd: currentPrice }],
    });
    expect(await orderIdsOf(cookie)).toEqual([]);
  });

  it("商品已下架：unlisted", async () => {
    const mug = await createStockedListing("馬克杯", 320, 10);
    const cookie = await signInCustomer("alice");
    await app.unlistProduct(await mintAccessJwt(), { id: mug.productId });

    expect(await app.checkout(cookie, checkoutInput([{ variantId: mug.variantId, quantity: 1, seenUnitPriceTwd: 320 }]))).toEqual({
      ok: false,
      reason: "checkout_rejected",
      issues: [{ variantId: mug.variantId, kind: "unlisted" }],
    });
  });

  it("可售數量不足：insufficient_stock，不透露確切數量", async () => {
    const mug = await createStockedListing("馬克杯", 320, 3);
    const cookie = await signInCustomer("alice");

    expect(await app.checkout(cookie, checkoutInput([{ variantId: mug.variantId, quantity: 4, seenUnitPriceTwd: 320 }]))).toEqual({
      ok: false,
      reason: "checkout_rejected",
      issues: [{ variantId: mug.variantId, kind: "insufficient_stock" }],
    });
  });

  it("商品不存在：product_not_found", async () => {
    const cookie = await signInCustomer("alice");

    expect(await app.checkout(cookie, checkoutInput([{ variantId: 9999, quantity: 1, seenUnitPriceTwd: 320 }]))).toEqual({
      ok: false,
      reason: "checkout_rejected",
      issues: [{ variantId: 9999, kind: "variant_not_found" }],
    });
  });

  it("多筆同時有問題時一次全部回傳，沒問題的那筆不在清單裡；整張不成立、可售數量不變", async () => {
    const fine = await createStockedListing("原子筆", 45, 10);
    const pricey = await createStockedListing("馬克杯", 320, 10);
    const gone = await createStockedListing("帆布袋", 200, 10);
    const scarce = await createStockedListing("筆記本", 80, 1);
    const cookie = await signInCustomer("alice");
    const jwt = await mintAccessJwt();
    await app.updateProduct(jwt, { id: pricey.productId, name: "馬克杯", description: "說明", priceTwd: 350 });
    await app.unlistProduct(jwt, { id: gone.productId });

    const result = await app.checkout(
      cookie,
      checkoutInput([
        { variantId: fine.variantId, quantity: 2, seenUnitPriceTwd: 45 },
        { variantId: pricey.variantId, quantity: 1, seenUnitPriceTwd: 320 },
        { variantId: gone.variantId, quantity: 1, seenUnitPriceTwd: 200 },
        { variantId: scarce.variantId, quantity: 2, seenUnitPriceTwd: 80 },
        { variantId: 9999, quantity: 1, seenUnitPriceTwd: 10 },
      ]),
    );

    expect(result).toEqual({
      ok: false,
      reason: "checkout_rejected",
      issues: [
        { variantId: pricey.variantId, kind: "price_changed", currentUnitPriceTwd: 350 },
        { variantId: gone.variantId, kind: "unlisted" },
        { variantId: scarce.variantId, kind: "insufficient_stock" },
        { variantId: 9999, kind: "variant_not_found" },
      ],
    });
    expect(await orderIdsOf(cookie)).toEqual([]);
    expect(await availableOf(fine.productId)).toBe(10);
  });
});

describe("全有全無", () => {
  beforeEach(resetDb);
  afterEach(() => vi.restoreAllMocks());

  it("有一筆不滿足時，其他滿足的明細也不成立：不留任何訂單，所有商品的可售數量都不變", async () => {
    const fine = await createStockedListing("原子筆", 45, 10);
    const scarce = await createStockedListing("筆記本", 80, 1);
    const cookie = await signInCustomer("alice");

    const result = await app.checkout(
      cookie,
      checkoutInput([
        { variantId: fine.variantId, quantity: 5, seenUnitPriceTwd: 45 },
        { variantId: scarce.variantId, quantity: 2, seenUnitPriceTwd: 80 },
      ]),
    );

    expect(result).toMatchObject({ ok: false, reason: "checkout_rejected" });
    expect(await orderIdsOf(cookie)).toEqual([]);
    expect(await availableOf(fine.productId)).toBe(10);
    expect(await availableOf(scarce.productId)).toBe(1);
  });
});

describe("保留（待付款訂單的訂單明細）", () => {
  beforeEach(resetDb);
  afterEach(() => vi.restoreAllMocks());

  it("結帳後可售數量減少、在庫數不變，後台看得到保留數", async () => {
    const mug = await createStockedListing("馬克杯", 320, 10);
    const cookie = await signInCustomer("alice");

    await app.checkout(cookie, checkoutInput([{ variantId: mug.variantId, quantity: 3, seenUnitPriceTwd: 320 }]));

    const jwt = await mintAccessJwt();
    expect(await app.getProductForAdmin(jwt, { id: mug.productId })).toMatchObject({
      ok: true,
      data: { onHand: 10, reserved: 3, available: 7 },
    });
    expect(await app.listProductsForAdmin(jwt)).toMatchObject({
      ok: true,
      data: [{ id: mug.productId, onHand: 10, reserved: 3, available: 7 }],
    });
  });

  it("保留佔住的量不能再被別人結帳：全部被保留後前台顯示不可購買，下一位顧客被拒為 insufficient_stock", async () => {
    const mug = await createStockedListing("馬克杯", 320, 4);
    const alice = await signInCustomer("alice");
    const bob = await signInCustomer("bob");
    await app.checkout(alice, checkoutInput([{ variantId: mug.variantId, quantity: 3, seenUnitPriceTwd: 320 }]));

    expect(await app.checkout(bob, checkoutInput([{ variantId: mug.variantId, quantity: 2, seenUnitPriceTwd: 320 }]))).toMatchObject({
      ok: false,
      issues: [{ variantId: mug.variantId, kind: "insufficient_stock" }],
    });
    expect(await app.checkout(bob, checkoutInput([{ variantId: mug.variantId, quantity: 1, seenUnitPriceTwd: 320 }]))).toMatchObject({ ok: true });
    expect(await app.listProducts()).toMatchObject({ ok: true, data: { items: [{ id: mug.productId, purchasable: false }] } });
  });

  it("庫存調整不能讓在庫數低於保留總和：在庫 10、保留 3，-8 被拒，-7 成功", async () => {
    const mug = await createStockedListing("馬克杯", 320, 10);
    const cookie = await signInCustomer("alice");
    await app.checkout(cookie, checkoutInput([{ variantId: mug.variantId, quantity: 3, seenUnitPriceTwd: 320 }]));
    const jwt = await mintAccessJwt();

    expect(await app.adjustStock(jwt, { variantId: mug.variantId, delta: -8, reason: "測試調整" })).toEqual({ ok: false, reason: "insufficient_stock" });
    expect(await app.adjustStock(jwt, { variantId: mug.variantId, delta: -7, reason: "測試調整" })).toEqual({ ok: true, data: { onHand: 3, available: 0 } });
  });
});

describe("結帳的並行", () => {
  beforeEach(resetDb);
  afterEach(() => vi.restoreAllMocks());

  it("在庫 1、兩位顧客同時結帳搶最後一件：恰好一張訂單成立，另一位被拒為 insufficient_stock", async () => {
    const mug = await createStockedListing("馬克杯", 320, 1);
    const alice = await signInCustomer("alice");
    const bob = await signInCustomer("bob");

    const results = await Promise.all(
      [alice, bob].map((cookie) => app.checkout(cookie, checkoutInput([{ variantId: mug.variantId, quantity: 1, seenUnitPriceTwd: 320 }]))),
    );

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      { ok: false, reason: "checkout_rejected", issues: [{ variantId: mug.variantId, kind: "insufficient_stock" }] },
    ]);
    expect((await orderIdsOf(alice)).length + (await orderIdsOf(bob)).length).toBe(1);
    expect(await availableOf(mug.productId)).toBe(0);
  });

  it("多人同時結帳多筆明細：成立的總量不超過在庫數，被拒的人不留任何訂單，可售數量 = 在庫數 − 成立的總量", async () => {
    const stockA = 5;
    const stockB = 7;
    const productA = await createStockedListing("馬克杯", 320, stockA);
    const productB = await createStockedListing("原子筆", 45, stockB);
    // 登入用的 stub 是全域的，逐一登入
    const customers: string[] = [];
    for (let index = 0; index < 10; index += 1) customers.push(await signInCustomer(`customer-${index}`));
    // 偶數位買 A×2 + B×3，奇數位只買 B×2：多筆明細搶同一批庫存
    const linesFor = (index: number) =>
      index % 2 === 0
        ? [
            { variantId: productA.variantId, quantity: 2, seenUnitPriceTwd: 320 },
            { variantId: productB.variantId, quantity: 3, seenUnitPriceTwd: 45 },
          ]
        : [{ variantId: productB.variantId, quantity: 2, seenUnitPriceTwd: 45 }];

    const results = await Promise.all(customers.map((cookie, index) => app.checkout(cookie, checkoutInput(linesFor(index)))));

    let reservedA = 0;
    let reservedB = 0;
    for (const [index, result] of results.entries()) {
      const orderIds = await orderIdsOf(customers[index]!);
      if (result.ok) {
        expect(orderIds).toEqual([result.data.orderId]);
        for (const line of linesFor(index)) {
          if (line.variantId === productA.variantId) reservedA += line.quantity;
          else reservedB += line.quantity;
        }
      } else {
        expect(result).toMatchObject({ ok: false, reason: "checkout_rejected" });
        expect(orderIds).toEqual([]);
      }
    }
    expect(results.some((result) => result.ok)).toBe(true);
    expect(reservedA).toBeLessThanOrEqual(stockA);
    expect(reservedB).toBeLessThanOrEqual(stockB);
    expect(await availableOf(productA.productId)).toBe(stockA - reservedA);
    expect(await availableOf(productB.productId)).toBe(stockB - reservedB);
  }, 15_000);
});

describe("結帳的冪等", () => {
  beforeEach(resetDb);
  afterEach(() => vi.restoreAllMocks());

  it("同一顧客同一冪等鍵重送：回同一張訂單，不重複保留、不重複成立", async () => {
    const mug = await createStockedListing("馬克杯", 320, 10);
    const cookie = await signInCustomer("alice");
    const input = checkoutInput([{ variantId: mug.variantId, quantity: 3, seenUnitPriceTwd: 320 }]);

    const first = await app.checkout(cookie, input);
    const second = await app.checkout(cookie, input);

    expect(second).toEqual(first);
    expect(await orderIdsOf(cookie)).toHaveLength(1);
    expect(await availableOf(mug.productId)).toBe(7);
  });

  it("重送時不重新檢查：即使庫存之後被別人買光，仍回原本那張訂單", async () => {
    const mug = await createStockedListing("馬克杯", 320, 2);
    const alice = await signInCustomer("alice");
    const bob = await signInCustomer("bob");
    const input = checkoutInput([{ variantId: mug.variantId, quantity: 2, seenUnitPriceTwd: 320 }]);
    const first = await app.checkout(alice, input);
    await app.adjustStock(await mintAccessJwt(), { variantId: mug.variantId, delta: 1, reason: "測試調整" });
    await app.checkout(bob, checkoutInput([{ variantId: mug.variantId, quantity: 1, seenUnitPriceTwd: 320 }]));

    expect(await app.checkout(alice, input)).toEqual(first);
    expect(await availableOf(mug.productId)).toBe(0);
  });

  it("同一個冪等鍵同時送出多次：只成立一張訂單、只保留一次", async () => {
    const mug = await createStockedListing("馬克杯", 320, 10);
    const cookie = await signInCustomer("alice");
    const input = checkoutInput([{ variantId: mug.variantId, quantity: 3, seenUnitPriceTwd: 320 }]);

    const results = await Promise.all(Array.from({ length: 5 }, () => app.checkout(cookie, input)));

    expect(results.every((result) => result.ok)).toBe(true);
    expect(new Set(results.map((result) => (result.ok ? result.data.orderId : null))).size).toBe(1);
    expect(await orderIdsOf(cookie)).toHaveLength(1);
    expect(await availableOf(mug.productId)).toBe(7);
  });

  it("不同顧客用同一個冪等鍵互不影響，各自成立自己的訂單", async () => {
    const mug = await createStockedListing("馬克杯", 320, 10);
    const alice = await signInCustomer("alice");
    const bob = await signInCustomer("bob");
    const input = checkoutInput([{ variantId: mug.variantId, quantity: 1, seenUnitPriceTwd: 320 }]);

    const [a, b] = await Promise.all([app.checkout(alice, input), app.checkout(bob, input)]);

    expect(a).toMatchObject({ ok: true });
    expect(b).toMatchObject({ ok: true });
    expect(a.ok && b.ok && a.data.orderId !== b.data.orderId).toBe(true);
    expect(await availableOf(mug.productId)).toBe(8);
  });

  it.each([
    ["明細不同", (mug: { variantId: number }) => ({ ...checkoutInput([{ variantId: mug.variantId, quantity: 2, seenUnitPriceTwd: 320 }]) })],
    ["收件資訊不同", (mug: { variantId: number }) => ({ ...checkoutInput([{ variantId: mug.variantId, quantity: 1, seenUnitPriceTwd: 320 }]), shippingInfo: { ...SHIPPING_INFO, address: "高雄市" } })],
  ])("同一顧客同一鍵但%s：回 idempotency_key_reused，不回舊訂單，也不多保留", async (_label, makeInput) => {
    const mug = await createStockedListing("馬克杯", 320, 10);
    const cookie = await signInCustomer("alice");
    const key = newKey();
    await app.checkout(cookie, checkoutInput([{ variantId: mug.variantId, quantity: 1, seenUnitPriceTwd: 320 }], key));

    expect(await app.checkout(cookie, { ...makeInput(mug), idempotencyKey: key })).toEqual({
      ok: false,
      reason: "idempotency_key_reused",
    });
    expect(await orderIdsOf(cookie)).toHaveLength(1);
    expect(await availableOf(mug.productId)).toBe(9);
  });

  it("同內容重送不受明細順序與收件資訊前後空白影響，仍回原訂單", async () => {
    const mug = await createStockedListing("馬克杯", 320, 10);
    const pen = await createStockedListing("原子筆", 45, 10);
    const cookie = await signInCustomer("alice");
    const key = newKey();
    const lines = [
      { variantId: mug.variantId, quantity: 1, seenUnitPriceTwd: 320 },
      { variantId: pen.variantId, quantity: 2, seenUnitPriceTwd: 45 },
    ];
    const first = await app.checkout(cookie, checkoutInput(lines, key));

    const again = await app.checkout(cookie, {
      ...checkoutInput([...lines].reverse(), key),
      shippingInfo: { ...SHIPPING_INFO, name: ` ${SHIPPING_INFO.name} ` },
    });

    expect(again).toEqual(first);
  });

  it("被拒的結帳不占用冪等鍵：修正後用同一個鍵重送可以成立", async () => {
    const mug = await createStockedListing("馬克杯", 320, 10);
    const cookie = await signInCustomer("alice");
    const key = newKey();
    await app.updateProduct(await mintAccessJwt(), { id: mug.productId, name: "馬克杯", description: "說明", priceTwd: 350 });

    expect(await app.checkout(cookie, checkoutInput([{ variantId: mug.variantId, quantity: 1, seenUnitPriceTwd: 320 }], key))).toMatchObject({
      ok: false,
      reason: "checkout_rejected",
    });
    expect(await app.checkout(cookie, checkoutInput([{ variantId: mug.variantId, quantity: 1, seenUnitPriceTwd: 350 }], key))).toMatchObject({
      ok: true,
      data: { totalTwd: 450 },
    });
  });
});

describe("我的訂單的權限與範圍", () => {
  beforeEach(resetDb);
  afterEach(() => vi.restoreAllMocks());

  it("沒有 session 時列出與查看訂單都是 unauthorized", async () => {
    expect(await app.listMyOrders("")).toEqual({ ok: false, reason: "unauthorized" });
    expect(await app.getMyOrder("", { orderId: 1 })).toEqual({ ok: false, reason: "unauthorized" });
    expect(await app.listMyOrders("better-auth.session_token=forged")).toEqual({ ok: false, reason: "unauthorized" });
  });

  it("只看得到自己的訂單：別人的訂單編號回 order_not_found，清單裡也沒有", async () => {
    const mug = await createStockedListing("馬克杯", 320, 10);
    const alice = await signInCustomer("alice");
    const bob = await signInCustomer("bob");
    const placed = await app.checkout(alice, checkoutInput([{ variantId: mug.variantId, quantity: 1, seenUnitPriceTwd: 320 }]));
    if (!placed.ok) throw new Error("結帳失敗");

    expect(await app.getMyOrder(bob, { orderId: placed.data.orderId })).toEqual({ ok: false, reason: "order_not_found" });
    expect(await orderIdsOf(bob)).toEqual([]);
    expect(await orderIdsOf(alice)).toEqual([placed.data.orderId]);
    expect(await app.getMyOrder(alice, { orderId: 9999 })).toEqual({ ok: false, reason: "order_not_found" });
  });

  it("清單依成立先後，新的在前", async () => {
    const mug = await createStockedListing("馬克杯", 320, 10);
    const cookie = await signInCustomer("alice");
    const first = await app.checkout(cookie, checkoutInput([{ variantId: mug.variantId, quantity: 1, seenUnitPriceTwd: 320 }]));
    const second = await app.checkout(cookie, checkoutInput([{ variantId: mug.variantId, quantity: 1, seenUnitPriceTwd: 320 }]));
    if (!first.ok || !second.ok) throw new Error("結帳失敗");

    expect(await orderIdsOf(cookie)).toEqual([second.data.orderId, first.data.orderId]);
  });
});

describe("結帳的輸入驗證", () => {
  beforeEach(resetDb);
  afterEach(() => vi.restoreAllMocks());

  async function setup() {
    const mug = await createStockedListing("馬克杯", 320, 10);
    const cookie = await signInCustomer("alice");
    const line = { variantId: mug.variantId, quantity: 1, seenUnitPriceTwd: 320 };
    return { cookie, line };
  }

  it.each([
    ["沒有任何明細", () => ({ lines: [] })],
    ["明細超過 20 筆", ({ line }: { line: LineInput }) => ({ lines: Array.from({ length: 21 }, (_, i) => ({ ...line, variantId: i + 1 })) })],
    ["同一商品重複", ({ line }: { line: LineInput }) => ({ lines: [line, line] })],
    ["數量為 0", ({ line }: { line: LineInput }) => ({ lines: [{ ...line, quantity: 0 }] })],
    ["數量超過 99", ({ line }: { line: LineInput }) => ({ lines: [{ ...line, quantity: 100 }] })],
    ["數量是小數", ({ line }: { line: LineInput }) => ({ lines: [{ ...line, quantity: 1.5 }] })],
    ["單價不是正整數", ({ line }: { line: LineInput }) => ({ lines: [{ ...line, seenUnitPriceTwd: 0 }] })],
    ["姓名空白", () => ({ shippingInfo: { ...SHIPPING_INFO, name: "   " } })],
    ["電話缺漏", () => ({ shippingInfo: { name: SHIPPING_INFO.name, address: SHIPPING_INFO.address } })],
    ["地址過長", () => ({ shippingInfo: { ...SHIPPING_INFO, address: "址".repeat(301) } })],
    ["冪等鍵格式不合", () => ({ idempotencyKey: "bad key!" })],
    ["冪等鍵缺漏", () => ({ idempotencyKey: undefined })],
  ])("%s被拒為 invalid_input，不成立訂單", async (_label, override) => {
    const { cookie, line } = await setup();
    const input = { ...checkoutInput([line]), ...override({ line }) };

    expect(await app.checkout(cookie, input)).toMatchObject({ ok: false, reason: "invalid_input", fields: expect.any(Object) });
    expect(await orderIdsOf(cookie)).toEqual([]);
  });

  it("輸入不是物件也被拒為 invalid_input", async () => {
    const { cookie } = await setup();
    expect(await app.checkout(cookie, null)).toMatchObject({ ok: false, reason: "invalid_input" });
  });

  it("查看訂單時編號無效被拒為 invalid_input", async () => {
    const { cookie } = await setup();
    expect(await app.getMyOrder(cookie, { orderId: 0 })).toMatchObject({ ok: false, reason: "invalid_input" });
  });
});

describe("結帳診斷不出原因", () => {
  it("重試上限用完仍無結論時回 checkout_unavailable，不丟例外", async () => {
    const mug = await createStockedListing("馬克杯", 320, 10);
    // 模擬「寫入什麼都沒發生、診斷又找不到問題」：batch 不做事，其餘照常讀取
    const inertBatch = { prepare: (query: string) => env.DB.prepare(query), batch: async () => Array.from({ length: 4 }, () => ({ meta: { changes: 0 } })) };
    // 已驗證聯絡 email 的前置檢查是讀取，照常通過；之後的寫入才被架空
    const customerId = (await app.getCustomerSession(await signInCustomer("alice"))).customer!.customerId;
    const service = createOrderService(inertBatch as unknown as D1Database, { now: () => Date.now() }, async () => customerId, async () => null);

    expect(await service.checkout("cookie", checkoutInput([{ variantId: mug.variantId, quantity: 1, seenUnitPriceTwd: 320 }]))).toEqual({
      ok: false,
      reason: "checkout_unavailable",
    });
  });
});
