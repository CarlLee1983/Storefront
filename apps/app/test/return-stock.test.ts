import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { mintAccessJwt } from "./access";
import { checkoutInput } from "./checkout-helpers";
import { resetDb } from "./db";
import { adminOrder } from "./shipment-helpers";
import { approveReturn, inspectReturn, receiveReturn, requestReturnOk, shippedMixedOrder, stockDetail } from "./return-helpers";

const app = exports.default;

beforeEach(resetDb);

async function movements(variantId: number) {
  const result = await app.listStockMovements(await mintAccessJwt(), { variantId });
  if (!result.ok) throw new Error("讀取流水失敗");
  return result.data.items.reverse();
}

/** 馬克杯退回 `quantity` 件並收回（待檢，不可售），回傳訂單資訊。 */
async function receivedMugs(quantity: number) {
  const order = await shippedMixedOrder();
  const requestId = await requestReturnOk(order.cookie, order.orderId, [{ orderLineId: order.mugLine.id, quantity }]);
  await approveReturn(requestId);
  return { ...order, requestId };
}

describe("不可售不是可售", () => {
  it("可售被不可售吃到 0：結帳被拒、有貨篩選排除該商品，其他商品不受影響", async () => {
    const { cookie, mugVariantId, mugLine, requestId } = await receivedMugs(3);
    await receiveReturn(requestId, [{ orderLineId: mugLine.id, receivedQuantity: 3 }]);
    const before = await stockDetail(mugVariantId);
    expect(before).toMatchObject({ unavailable: 3, available: 7 });
    await app.adjustStock(await mintAccessJwt(), { variantId: mugVariantId, delta: -before.available, reason: "盤損" });
    expect(await stockDetail(mugVariantId)).toMatchObject({ onHand: 3, unavailable: 3, available: 0 });

    expect(await app.checkout(cookie, checkoutInput([{ variantId: mugVariantId, quantity: 1, seenUnitPriceTwd: 320 }]))).toMatchObject({ ok: false, reason: "checkout_rejected" });
    const listed = await app.listProducts({ inStock: true });
    if (!listed.ok) throw new Error("讀取商品列表失敗");
    expect(listed.data.items.map((item) => item.name)).toEqual(["餐桌"]);
  });
});

describe("並行：實物事件只成立一次", () => {
  it("並行收回（不同數量）：只有一個成立，入庫與流水只一筆，數字等於成立的那一個", async () => {
    const { mugVariantId, mugLine, requestId } = await receivedMugs(3);
    const before = await stockDetail(mugVariantId);

    const results = await Promise.all([2, 3].map((receivedQuantity) => receiveReturn(requestId, [{ orderLineId: mugLine.id, receivedQuantity }])));

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, reason: "return_wrong_state" }]);
    const winner = (await env.DB.prepare("SELECT received_quantity AS q FROM return_request_items WHERE request_id = ?").bind(requestId).first<{ q: number }>())!.q;
    expect(await stockDetail(mugVariantId)).toMatchObject({ onHand: before.onHand + winner, unavailable: winner });
    expect((await movements(mugVariantId)).filter((movement) => movement.kind === "return_received")).toMatchObject([{ delta: winner, unavailableAfter: winner }]);
  });

  it("並行收回（同內容）：入庫與流水只成立一次，兩邊都回成功", async () => {
    const { mugVariantId, mugLine, requestId } = await receivedMugs(3);
    const before = await stockDetail(mugVariantId);

    const results = await Promise.all([0, 1].map(() => receiveReturn(requestId, [{ orderLineId: mugLine.id, receivedQuantity: 3 }])));

    expect(results.every((result) => result.ok)).toBe(true);
    expect(await stockDetail(mugVariantId)).toMatchObject({ onHand: before.onHand + 3, unavailable: 3 });
    expect((await movements(mugVariantId)).filter((movement) => movement.kind === "return_received")).toHaveLength(1);
  });

  it("已完成的案件同內容重送檢查：庫存數字與流水都不再變動", async () => {
    const { mugVariantId, mugLine, requestId } = await receivedMugs(3);
    await receiveReturn(requestId, [{ orderLineId: mugLine.id, receivedQuantity: 3 }]);
    const items = [{ orderLineId: mugLine.id, sellableQuantity: 2, damagedQuantity: 1 }];
    await inspectReturn(requestId, items);
    const after = await stockDetail(mugVariantId);

    expect(await inspectReturn(requestId, items)).toMatchObject({ ok: true, data: { replayed: true } });

    expect(await stockDetail(mugVariantId)).toEqual(after);
    expect((await movements(mugVariantId)).filter((movement) => movement.kind === "return_inspected")).toHaveLength(1);
  });

  it("並行檢查（不同結果）：只有一個成立，轉可售與退款各只一次，不可售等於成立結果的損壞數", async () => {
    const { mugVariantId, mugLine, orderId, requestId } = await receivedMugs(3);
    await receiveReturn(requestId, [{ orderLineId: mugLine.id, receivedQuantity: 3 }]);
    const outcomes = [{ sellableQuantity: 3, damagedQuantity: 0 }, { sellableQuantity: 1, damagedQuantity: 2 }];

    const results = await Promise.all(outcomes.map((outcome) => inspectReturn(requestId, [{ orderLineId: mugLine.id, ...outcome }])));

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, reason: "return_wrong_state" }]);
    const winner = (await env.DB.prepare("SELECT damaged_quantity AS d FROM return_request_items WHERE request_id = ?").bind(requestId).first<{ d: number }>())!.d;
    expect(await stockDetail(mugVariantId)).toMatchObject({ unavailable: winner });
    expect((await movements(mugVariantId)).filter((movement) => movement.kind === "return_inspected")).toHaveLength(1);
    expect((await adminOrder(orderId)).refunds).toHaveLength(1);
  });

  it("報廢與檢查同時：待檢的數量不能被報廢吃掉，不可售不會小於 0，流水與數字對得上", async () => {
    const { mugVariantId, mugLine, requestId } = await receivedMugs(3);
    await receiveReturn(requestId, [{ orderLineId: mugLine.id, receivedQuantity: 3 }]);
    const jwt = await mintAccessJwt();

    const [inspected, scrapped] = await Promise.all([
      inspectReturn(requestId, [{ orderLineId: mugLine.id, sellableQuantity: 1, damagedQuantity: 2 }]),
      app.scrapUnavailableStock(jwt, { variantId: mugVariantId, quantity: 2, reason: "損壞" }),
    ]);

    expect(inspected.ok).toBe(true);
    const stock = await stockDetail(mugVariantId);
    const scrapMovements = (await movements(mugVariantId)).filter((movement) => movement.kind === "scrap");
    if (scrapped.ok) {
      // 檢查先落地、確認了 2 件損壞品，報廢才有東西可報廢
      expect(stock).toMatchObject({ onHand: 7 + 3 - 2, unavailable: 0 });
      expect(scrapMovements).toHaveLength(1);
    } else {
      // 報廢先落地時，3 件都還是待檢，不能報廢
      expect(scrapped).toEqual({ ok: false, reason: "insufficient_unavailable" });
      expect(stock).toMatchObject({ onHand: 7 + 3, unavailable: 2 });
      expect(scrapMovements).toHaveLength(0);
    }
  });
});

describe("報廢的下限", () => {
  it("報廢後在庫數不會小於 0：即使不可售被直接弄得比在庫大也被擋", async () => {
    const { mugVariantId } = await shippedMixedOrder();
    await env.DB.prepare("UPDATE product_variants SET unavailable = 9 WHERE id = ?").bind(mugVariantId).run();
    const before = await stockDetail(mugVariantId);

    const result = await app.scrapUnavailableStock(await mintAccessJwt(), { variantId: mugVariantId, quantity: 9, reason: "壞" });

    expect(result).toEqual({ ok: false, reason: "insufficient_unavailable" });
    expect((await stockDetail(mugVariantId)).onHand).toBe(before.onHand);
  });
});
