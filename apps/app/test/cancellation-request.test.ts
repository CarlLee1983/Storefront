import { exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { generateRogueKey, mintAccessJwt } from "./access";
import { decide, paidMixedOrder, requestCancel, requestCancelOk } from "./cancellation-helpers";
import { newKey } from "./checkout-helpers";
import { signInCustomer } from "./customers";
import { forceOrderStatus, resetDb } from "./db";
import { orderOf, placeMugOrder, stockOf } from "./payment-helpers";
import { adminOrder, shipRemaining } from "./shipment-helpers";

const app = exports.default;

beforeEach(resetDb);

describe("申請取消：成立即凍結交運、保留不釋放", () => {
  it("申請成立後該數量待審：顧客與管理員都看得到各案與數量，保留（可售數量）不變", async () => {
    const { cookie, orderId, mugVariantId, mugLine } = await paidMixedOrder();
    const before = await stockOf(mugVariantId);

    const result = await requestCancel(cookie, orderId, [{ orderLineId: mugLine.id, quantity: 2 }], { reason: "  買重複了  " });

    expect(result).toEqual({ ok: true, data: { requestId: expect.any(Number), replayed: false } });
    expect(await stockOf(mugVariantId)).toEqual(before);
    const mine = await orderOf(cookie, orderId);
    expect(mine.status).toBe("paid");
    expect(mine.lines.find((line) => line.id === mugLine.id)).toMatchObject({ shippedQuantity: 0, cancelledQuantity: 0, pendingCancellationQuantity: 2 });
    expect(mine.cancellations).toEqual([
      expect.objectContaining({ status: "pending", reason: "買重複了", refund: null, items: [expect.objectContaining({ productName: "馬克杯", quantity: 2, amountTwd: 640 })] }),
    ]);
    expect((await adminOrder(orderId)).cancellations).toMatchObject([{ status: "pending", customerEmail: "alice@example.com", decidedBy: null }]);
  });

  it("待審的數量不可交運，沒被占用的數量照常交運", async () => {
    const { cookie, orderId, mugLine } = await paidMixedOrder();
    await requestCancelOk(cookie, orderId, [{ orderLineId: mugLine.id, quantity: 2 }]);

    expect(await shipRemaining(orderId)).toEqual({ ok: false, reason: "shipment_quantity_exceeded" });
    const mugOnly = await shipRemaining(orderId, { items: [{ orderLineId: mugLine.id, quantity: 1 }] });

    expect(mugOnly).toMatchObject({ ok: true, data: { status: "partially_shipped" } });
    expect((await adminOrder(orderId)).lines.find((line) => line.id === mugLine.id)).toMatchObject({ shippedQuantity: 1, pendingCancellationQuantity: 2 });
  });

  it("交運先成立：已交運的數量不能申請取消（走退貨），只能取消剩下未交運且未被占用的數量", async () => {
    const { cookie, orderId, mugLine } = await paidMixedOrder();
    expect(await shipRemaining(orderId, { items: [{ orderLineId: mugLine.id, quantity: 2 }] })).toMatchObject({ ok: true });

    expect(await requestCancel(cookie, orderId, [{ orderLineId: mugLine.id, quantity: 2 }])).toEqual({ ok: false, reason: "cancellation_quantity_exceeded" });
    expect(await requestCancel(cookie, orderId, [{ orderLineId: mugLine.id, quantity: 1 }])).toMatchObject({ ok: true });
    expect(await shipRemaining(orderId, { items: [{ orderLineId: mugLine.id, quantity: 1 }] })).toEqual({ ok: false, reason: "shipment_quantity_exceeded" });
  });

  it("同一明細重複申請超過可取消數量被擋，不會重複占用同一件商品", async () => {
    const { cookie, orderId, mugLine } = await paidMixedOrder();
    await requestCancelOk(cookie, orderId, [{ orderLineId: mugLine.id, quantity: 2 }]);

    expect(await requestCancel(cookie, orderId, [{ orderLineId: mugLine.id, quantity: 2 }])).toEqual({ ok: false, reason: "cancellation_quantity_exceeded" });
    expect(await requestCancel(cookie, orderId, [{ orderLineId: mugLine.id, quantity: 1 }])).toMatchObject({ ok: true });
    expect(await requestCancel(cookie, orderId, [{ orderLineId: mugLine.id, quantity: 1 }])).toEqual({ ok: false, reason: "cancellation_quantity_exceeded" });
    expect((await adminOrder(orderId)).lines.find((line) => line.id === mugLine.id)!.pendingCancellationQuantity).toBe(3);
  });

  it("同一冪等鍵重送回原申請，不重複占用；同鍵不同內容回 request_key_conflict", async () => {
    const { cookie, orderId, mugLine } = await paidMixedOrder();
    const requestKey = newKey();
    const first = await app.requestCancellation(cookie, { orderId, requestKey, items: [{ orderLineId: mugLine.id, quantity: 2 }] });
    const again = await app.requestCancellation(cookie, { orderId, requestKey, items: [{ orderLineId: mugLine.id, quantity: 2 }] });
    const different = await app.requestCancellation(cookie, { orderId, requestKey, items: [{ orderLineId: mugLine.id, quantity: 1 }] });

    expect(first).toMatchObject({ ok: true, data: { replayed: false } });
    expect(again).toEqual({ ok: true, data: { requestId: (first as { data: { requestId: number } }).data.requestId, replayed: true } });
    expect(different).toEqual({ ok: false, reason: "request_key_conflict" });
    expect((await orderOf(cookie, orderId)).cancellations).toHaveLength(1);
  });

  it("申請與交運搶同一數量並行：只有一方成立，數量不會同時被交運與取消", async () => {
    const { cookie, orderId, mugLine } = await paidMixedOrder();

    const [shipped, requested] = await Promise.all([
      shipRemaining(orderId, { items: [{ orderLineId: mugLine.id, quantity: 3 }] }),
      requestCancel(cookie, orderId, [{ orderLineId: mugLine.id, quantity: 3 }]),
    ]);

    expect([shipped.ok, requested.ok].filter(Boolean)).toHaveLength(1);
    const line = (await adminOrder(orderId)).lines.find((candidate) => candidate.id === mugLine.id)!;
    expect(line.shippedQuantity + line.pendingCancellationQuantity).toBe(3);
  });

  it("兩個申請搶同一明細的最後數量並行：只有一個成立", async () => {
    const { cookie, orderId, mugLine } = await paidMixedOrder();

    const results = await Promise.all([
      requestCancel(cookie, orderId, [{ orderLineId: mugLine.id, quantity: 3 }]),
      requestCancel(cookie, orderId, [{ orderLineId: mugLine.id, quantity: 3 }]),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok)).toEqual({ ok: false, reason: "cancellation_quantity_exceeded" });
  });
});

describe("申請取消：權限與輸入", () => {
  it("沒有登入、別人的訂單、不存在的訂單：一律不洩漏", async () => {
    const { cookie, orderId, mugLine } = await paidMixedOrder();
    const bob = await signInCustomer("bob");

    expect(await app.requestCancellation("", { orderId, requestKey: newKey(), items: [{ orderLineId: mugLine.id, quantity: 1 }] })).toEqual({ ok: false, reason: "unauthorized" });
    expect(await requestCancel(bob, orderId, [{ orderLineId: mugLine.id, quantity: 1 }])).toEqual({ ok: false, reason: "order_not_found" });
    expect(await requestCancel(cookie, orderId + 999, [{ orderLineId: mugLine.id, quantity: 1 }])).toEqual({ ok: false, reason: "order_not_found" });
    expect((await orderOf(cookie, orderId)).cancellations).toEqual([]);
  });

  it("別的顧客看不到這案取消申請；待付款訂單不能申請；明細不屬於這張訂單被擋；輸入驗證", async () => {
    const { cookie, orderId, mugLine } = await paidMixedOrder();
    const bob = await signInCustomer("bob");
    const { orderId: bobOrder } = await placeMugOrder(bob, { quantity: 1 });
    await requestCancelOk(cookie, orderId, [{ orderLineId: mugLine.id, quantity: 1 }]);

    expect(await requestCancel(bob, bobOrder, [{ orderLineId: mugLine.id, quantity: 1 }])).toEqual({ ok: false, reason: "order_not_cancellable" });
    await forceOrderStatus(bobOrder, "paid");
    expect(await requestCancel(bob, bobOrder, [{ orderLineId: mugLine.id, quantity: 1 }])).toEqual({ ok: false, reason: "cancellation_line_invalid" });
    expect((await orderOf(bob, bobOrder)).cancellations).toEqual([]);
    expect(await requestCancel(cookie, orderId, [])).toMatchObject({ ok: false, reason: "invalid_input" });
    expect(await requestCancel(cookie, orderId, [{ orderLineId: mugLine.id, quantity: 0 }])).toMatchObject({ ok: false, reason: "invalid_input" });
    expect(await requestCancel(cookie, orderId, [{ orderLineId: mugLine.id, quantity: 1 }, { orderLineId: mugLine.id, quantity: 1 }])).toMatchObject({ ok: false, reason: "invalid_input" });
  });

  it("審核與待辦只給管理員：沒有或偽造的 Access JWT 一律 unauthorized，申請不動", async () => {
    const { cookie, orderId, mugLine } = await paidMixedOrder();
    const requestId = await requestCancelOk(cookie, orderId, [{ orderLineId: mugLine.id, quantity: 1 }]);
    const rogue = await mintAccessJwt({ key: await generateRogueKey() });

    expect(await app.decideCancellation("", { requestId, decision: "approve" })).toEqual({ ok: false, reason: "unauthorized" });
    expect(await app.decideCancellation(rogue, { requestId, decision: "approve" })).toEqual({ ok: false, reason: "unauthorized" });
    expect(await app.listCancellationsToReview(rogue)).toEqual({ ok: false, reason: "unauthorized" });
    expect(await decide(requestId + 999, "approve")).toEqual({ ok: false, reason: "cancellation_not_found" });
    expect((await orderOf(cookie, orderId)).cancellations[0]!.status).toBe("pending");
  });
});
