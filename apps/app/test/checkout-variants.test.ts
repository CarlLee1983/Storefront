import { exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { mintAccessJwt } from "./access";
import { checkoutInput, createStockedListing } from "./checkout-helpers";
import { signInCustomer } from "./customers";
import { resetDb } from "./db";
import { placeOrder, stockOf } from "./payment-helpers";
import { createOptionListing } from "./variant-helpers";

const app = exports.default;

async function createTable() {
  return createOptionListing("餐桌", ["尺寸", "顏色"], [
    { values: ["120 公分", "胡桃色"], priceTwd: 9000, onHand: 3 },
    { values: ["150 公分", "胡桃色"], priceTwd: 12000, onHand: 1 },
  ]);
}

describe("結帳：同商品的不同變體", () => {
  beforeEach(resetDb);

  it("同一張訂單選購同商品的不同變體：不合併、各自單價與選項快照、各自保留庫存", async () => {
    const alice = await signInCustomer("alice");
    const { productId, variantIds } = await createTable();

    const orderId = await placeOrder(alice, [
      { variantId: variantIds[0]!, quantity: 2, seenUnitPriceTwd: 9000 },
      { variantId: variantIds[1]!, quantity: 1, seenUnitPriceTwd: 12000 },
    ]);

    expect(await app.getMyOrder(alice, { orderId })).toMatchObject({ ok: true, data: { totalTwd: 30000, lines: [
      { productId, variantId: variantIds[0], productName: "餐桌", variantLabel: "120 公分 / 胡桃色", quantity: 2, unitPriceTwd: 9000 },
      { productId, variantId: variantIds[1], productName: "餐桌", variantLabel: "150 公分 / 胡桃色", quantity: 1, unitPriceTwd: 12000 },
    ] } });
    expect(await stockOf(variantIds[0]!)).toEqual({ onHand: 3, available: 1 });
    expect(await stockOf(variantIds[1]!)).toEqual({ onHand: 1, available: 0 });
  });

  it("某個變體售罄不影響同商品其他變體；要買售罄的那個被拒且不保留任何庫存", async () => {
    const alice = await signInCustomer("alice");
    const { variantIds } = await createTable();
    await placeOrder(alice, [{ variantId: variantIds[1]!, quantity: 1, seenUnitPriceTwd: 12000 }]);

    const bob = await signInCustomer("bob");
    expect(await app.checkout(bob, checkoutInput([
      { variantId: variantIds[0]!, quantity: 1, seenUnitPriceTwd: 9000 },
      { variantId: variantIds[1]!, quantity: 1, seenUnitPriceTwd: 12000 },
    ]))).toEqual({ ok: false, reason: "checkout_rejected", issues: [{ variantId: variantIds[1], kind: "insufficient_stock" }] });
    expect(await stockOf(variantIds[0]!)).toEqual({ onHand: 3, available: 3 });

    await placeOrder(bob, [{ variantId: variantIds[0]!, quantity: 3, seenUnitPriceTwd: 9000 }]);
    expect(await stockOf(variantIds[0]!)).toEqual({ onHand: 3, available: 0 });
  });

  it("結帳再次驗證價格：變體改價後以舊價結帳被拒並回報現價，別的變體不受影響", async () => {
    const jwt = await mintAccessJwt();
    const alice = await signInCustomer("alice");
    const { variantIds } = await createTable();
    await app.updateVariant(jwt, { variantId: variantIds[0]!, optionValues: ["120 公分", "胡桃色"], priceTwd: 9500 });

    expect(await app.checkout(alice, checkoutInput([
      { variantId: variantIds[0]!, quantity: 1, seenUnitPriceTwd: 9000 },
      { variantId: variantIds[1]!, quantity: 1, seenUnitPriceTwd: 12000 },
    ]))).toEqual({ ok: false, reason: "checkout_rejected", issues: [{ variantId: variantIds[0], kind: "price_changed", currentUnitPriceTwd: 9500 }] });
  });

  it("停賣的變體不能結帳；恢復販售後可以，其他變體照常", async () => {
    const jwt = await mintAccessJwt();
    const alice = await signInCustomer("alice");
    const { variantIds } = await createTable();
    await app.setVariantDiscontinued(jwt, { variantId: variantIds[0]!, discontinued: true });

    const line = { variantId: variantIds[0]!, quantity: 1, seenUnitPriceTwd: 9000 };
    expect(await app.checkout(alice, checkoutInput([line]))).toEqual({ ok: false, reason: "checkout_rejected", issues: [{ variantId: variantIds[0], kind: "discontinued" }] });
    expect(await stockOf(variantIds[0]!)).toEqual({ onHand: 3, available: 3 });
    expect(await app.checkout(alice, checkoutInput([{ variantId: variantIds[1]!, quantity: 1, seenUnitPriceTwd: 12000 }]))).toMatchObject({ ok: true });

    await app.setVariantDiscontinued(jwt, { variantId: variantIds[0]!, discontinued: false });
    expect(await app.checkout(alice, checkoutInput([line]))).toMatchObject({ ok: true });
  });

  it("下單後變體停賣或改選項值：既有訂單保留快照，取消仍釋放該變體的保留", async () => {
    const jwt = await mintAccessJwt();
    const alice = await signInCustomer("alice");
    const { variantIds } = await createTable();
    const orderId = await placeOrder(alice, [{ variantId: variantIds[0]!, quantity: 2, seenUnitPriceTwd: 9000 }]);

    await app.updateVariant(jwt, { variantId: variantIds[0]!, optionValues: ["125 公分", "胡桃色"], priceTwd: 9800 });
    await app.setVariantDiscontinued(jwt, { variantId: variantIds[0]!, discontinued: true });

    expect(await app.getMyOrder(alice, { orderId })).toMatchObject({ ok: true, data: { totalTwd: 18000, lines: [{ variantLabel: "120 公分 / 胡桃色", unitPriceTwd: 9000, quantity: 2 }] } });
    expect(await app.getOrderForAdmin(jwt, { orderId })).toMatchObject({ ok: true, data: { lines: [{ variantLabel: "120 公分 / 胡桃色" }] } });
    expect(await stockOf(variantIds[0]!)).toEqual({ onHand: 3, available: 1 });

    expect(await app.cancelOrder(alice, { orderId })).toMatchObject({ ok: true });
    expect(await stockOf(variantIds[0]!)).toEqual({ onHand: 3, available: 3 });
  });

  it("無選項商品仍可結帳，訂單明細沒有選項標籤", async () => {
    const alice = await signInCustomer("alice");
    const { variantId } = await createStockedListing("馬克杯", 320, 5);

    const orderId = await placeOrder(alice, [{ variantId, quantity: 1, seenUnitPriceTwd: 320 }]);

    expect(await app.getMyOrder(alice, { orderId })).toMatchObject({ ok: true, data: { lines: [{ productName: "馬克杯", variantLabel: "" }] } });
  });

  it("顧客只能讀自己訂單的變體明細", async () => {
    const alice = await signInCustomer("alice");
    const bob = await signInCustomer("bob");
    const { variantIds } = await createTable();
    const orderId = await placeOrder(alice, [{ variantId: variantIds[0]!, quantity: 1, seenUnitPriceTwd: 9000 }]);

    expect(await app.getMyOrder(bob, { orderId })).toMatchObject({ ok: false });
    expect(await app.getMyOrder("", { orderId })).toMatchObject({ ok: false, reason: "unauthorized" });
  });
});
