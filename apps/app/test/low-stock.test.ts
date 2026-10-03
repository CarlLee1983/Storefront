import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { mintAccessJwt } from "./access";
import { createStockedListing } from "./checkout-helpers";
import { signInCustomer } from "./customers";
import { forceOrderStatus, resetDb } from "./db";
import { placeMugOrder } from "./payment-helpers";
import { createOptionListing } from "./variant-helpers";

const app = exports.default;

async function setThreshold(variantId: number, lowStockThreshold: number | null) {
  return app.setLowStockThreshold(await mintAccessJwt(), { variantId, lowStockThreshold });
}

async function lowStock() {
  const result = await app.listLowStockVariants(await mintAccessJwt());
  if (!result.ok) throw new Error(`讀取低庫存失敗：${result.reason}`);
  return result.data.items;
}

describe("低庫存提醒", () => {
  beforeEach(resetDb);

  it("沒設門檻的變體不提醒，設了門檻且可售數量不高於門檻才列入", async () => {
    const { variantId } = await createStockedListing("馬克杯", 320, 5);
    expect(await lowStock()).toEqual([]);

    expect(await setThreshold(variantId, 4)).toMatchObject({ ok: true });
    expect(await lowStock()).toEqual([]);

    await setThreshold(variantId, 5);
    expect(await lowStock()).toEqual([expect.objectContaining({ variantId, productName: "馬克杯", threshold: 5, onHand: 5, available: 5 })]);

    await setThreshold(variantId, null);
    expect(await lowStock()).toEqual([]);
  });

  it("庫存調整後提醒同步更新，補貨後移出、盤損後列入，並可用流水對回", async () => {
    const jwt = await mintAccessJwt();
    const { variantId } = await createStockedListing("馬克杯", 320, 10);
    await setThreshold(variantId, 3);
    expect(await lowStock()).toEqual([]);

    await app.adjustStock(jwt, { variantId, delta: -8, reason: "盤損" });
    expect(await lowStock()).toEqual([expect.objectContaining({ variantId, available: 2 })]);

    await app.adjustStock(jwt, { variantId, delta: 20, reason: "補貨" });
    expect(await lowStock()).toEqual([]);

    const ledger = await app.listStockMovements(jwt, { variantId });
    expect(ledger).toMatchObject({ ok: true, data: { items: [expect.objectContaining({ reason: "補貨", onHandAfter: 22 }), expect.objectContaining({ reason: "盤損", onHandAfter: 2 }), expect.anything()] } });
  });

  it("保留不當成可售：在庫夠但被訂單保留後可售降到門檻就提醒，取消訂單後移出", async () => {
    const alice = await signInCustomer("alice");
    const { orderId, variantId } = await placeMugOrder(alice, { onHand: 10, quantity: 8 });
    await setThreshold(variantId, 3);

    expect(await lowStock()).toEqual([expect.objectContaining({ variantId, onHand: 10, reserved: 8, available: 2 })]);

    await forceOrderStatus(orderId, "cancelled");
    expect(await lowStock()).toEqual([]);
  });

  it("不可售數量不當成可售", async () => {
    const { variantId } = await createStockedListing("馬克杯", 320, 10);
    await setThreshold(variantId, 3);
    // 不可售數量的產生路徑（退貨）由 return-*.test.ts 驗證；這裡直接寫入資料列，只驗提醒不把它當可售
    await env.DB.prepare("UPDATE product_variants SET unavailable = 8 WHERE id = ?").bind(variantId).run();

    expect(await lowStock()).toEqual([expect.objectContaining({ variantId, onHand: 10, unavailable: 8, available: 2 })]);
  });

  it("停賣的變體不提醒，恢復販售後再列入", async () => {
    const jwt = await mintAccessJwt();
    const { variantId } = await createStockedListing("馬克杯", 320, 1);
    await setThreshold(variantId, 3);
    await app.setVariantDiscontinued(jwt, { variantId, discontinued: true });
    expect(await lowStock()).toEqual([]);

    await app.setVariantDiscontinued(jwt, { variantId, discontinued: false });
    expect(await lowStock()).toHaveLength(1);
  });

  it("門檻可在新增變體時一併設定，清單依可售少的在前並帶選項值", async () => {
    const jwt = await mintAccessJwt();
    const { productId, variantIds } = await createOptionListing("沙發", ["顏色"], [
      { values: ["灰"], priceTwd: 9000, onHand: 4 },
    ]);
    const created = await app.createVariant(jwt, { productId, optionValues: ["藍"], priceTwd: 9000, lowStockThreshold: 2 });
    if (!created.ok) throw new Error("新增變體失敗");
    await app.adjustStock(jwt, { variantId: created.data.id, delta: 1, reason: "補貨" });
    await setThreshold(variantIds[0]!, 10);

    expect((await lowStock()).map(({ variantId, optionValues, available }) => ({ variantId, optionValues, available }))).toEqual([
      { variantId: created.data.id, optionValues: ["藍"], available: 1 },
      { variantId: variantIds[0], optionValues: ["灰"], available: 4 },
    ]);
  });

  it("後台變體資料帶出門檻", async () => {
    const jwt = await mintAccessJwt();
    const { productId, variantId } = await createStockedListing("馬克杯", 320, 1);
    await setThreshold(variantId, 7);
    const found = await app.getProductForAdmin(jwt, { id: productId });
    expect(found).toMatchObject({ ok: true, data: { variants: [expect.objectContaining({ lowStockThreshold: 7 })] } });
  });

  it("門檻輸入驗證：負數、非整數、過大被拒絕，不更動既有值", async () => {
    const { variantId } = await createStockedListing("馬克杯", 320, 1);
    await setThreshold(variantId, 3);
    for (const bad of [-1, 1.5, 1_000_001]) {
      expect(await setThreshold(variantId, bad)).toMatchObject({ ok: false, reason: "invalid_input" });
    }
    expect(await lowStock()).toEqual([expect.objectContaining({ threshold: 3 })]);
  });

  it("沒有管理員身分不能讀低庫存清單，也不能設門檻", async () => {
    const { variantId } = await createStockedListing("馬克杯", 320, 1);
    expect(await app.listLowStockVariants("not-a-jwt")).toMatchObject({ ok: false, reason: "unauthorized" });
    expect(await app.setLowStockThreshold("not-a-jwt", { variantId, lowStockThreshold: 3 })).toMatchObject({ ok: false, reason: "unauthorized" });
    expect(await app.updateVariant("not-a-jwt", { variantId, optionValues: [], priceTwd: 320, lowStockThreshold: 3 })).toMatchObject({ ok: false, reason: "unauthorized" });
  });

  it("只設門檻不動價格：先改價再單獨送門檻，價格不會被改回", async () => {
    const jwt = await mintAccessJwt();
    const { productId, variantId } = await createStockedListing("馬克杯", 320, 1);
    await app.updateProduct(jwt, { id: productId, name: "馬克杯", description: "說明", priceTwd: 450 });
    expect(await setThreshold(variantId, 3)).toMatchObject({ ok: true });

    expect(await app.getProductForAdmin(jwt, { id: productId })).toMatchObject({ ok: true, data: { variants: [expect.objectContaining({ priceTwd: 450, lowStockThreshold: 3 })] } });
  });

  it("設定不存在的變體回 variant_not_found", async () => {
    expect(await setThreshold(999_999, 3)).toMatchObject({ ok: false, reason: "variant_not_found" });
  });

  it("下架商品仍列入（下架期間可補貨待重新上架）", async () => {
    const jwt = await mintAccessJwt();
    const { productId, variantId } = await createStockedListing("馬克杯", 320, 1);
    await setThreshold(variantId, 3);
    await app.unlistProduct(jwt, { id: productId });
    expect(await lowStock()).toEqual([expect.objectContaining({ variantId })]);
  });

  it("門檻 0：可售 1 不列入，賣完（可售 0）才列入", async () => {
    const jwt = await mintAccessJwt();
    const { variantId } = await createStockedListing("馬克杯", 320, 1);
    await setThreshold(variantId, 0);
    expect(await lowStock()).toEqual([]);

    await app.adjustStock(jwt, { variantId, delta: -1, reason: "盤損" });
    expect(await lowStock()).toEqual([expect.objectContaining({ variantId, available: 0 })]);
  });

  it("超過上限時只回可售最少的前 200 筆並標示 truncated", async () => {
    const jwt = await mintAccessJwt();
    const { productId } = await createStockedListing("馬克杯", 320, 0);
    const listed = await app.getProductForAdmin(jwt, { id: productId });
    if (!listed.ok) throw new Error("讀取商品失敗");
    // 直接寫資料列補足 201 個有門檻的變體（選項值唯一即可），避免走 RPC 的二次方變慢
    await env.DB.batch(Array.from({ length: 201 }, (_, index) =>
      env.DB.prepare("INSERT INTO product_variants (product_id, is_default, price_twd, on_hand, option1_value, low_stock_threshold) VALUES (?, 0, 100, ?, ?, 1000)").bind(productId, index + 1, `v${index}`)));

    const result = await app.listLowStockVariants(jwt);
    if (!result.ok) throw new Error("讀取低庫存失敗");
    expect(result.data.truncated).toBe(true);
    expect(result.data.items).toHaveLength(200);
    expect(result.data.items[0]!.available).toBe(1);
    expect(result.data.items[199]!.available).toBe(200);
  });
});
