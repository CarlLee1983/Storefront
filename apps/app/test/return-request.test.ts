import { exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signInCustomer } from "./customers";
import { paidMixedOrder } from "./cancellation-helpers";
import { resetDb } from "./db";
import { adminOrder, shipRemaining } from "./shipment-helpers";
import { approveReturn, decideReturn, receiveReturn, requestReturn, requestReturnOk, shippedMixedOrder } from "./return-helpers";

const app = exports.default;

// 每個測試都要建商品、走完付款與交運，全套並行時會比預設 5 秒慢（比照 cancellation-decide）
vi.setConfig({ testTimeout: 30_000 });

beforeEach(resetDb);

const kindsOf = async (cookie: string) => {
  const mail = await app.listMyMail(cookie);
  if (!mail.ok) throw new Error("讀信失敗");
  return mail.data.map((message) => message.kind).sort();
};

describe("申請退貨", () => {
  it("對已交運的數量申請成立：待審、占用數量，顧客在訂單看得到；同鍵重送回原申請，同鍵不同內容衝突", async () => {
    const { cookie, orderId, mugLine } = await shippedMixedOrder();

    const first = await app.requestReturn(cookie, { orderId, requestKey: "k1", items: [{ orderLineId: mugLine.id, quantity: 2 }], reason: "尺寸不合" });
    expect(first).toMatchObject({ ok: true, data: { replayed: false } });
    const replay = await app.requestReturn(cookie, { orderId, requestKey: "k1", items: [{ orderLineId: mugLine.id, quantity: 2 }], reason: "尺寸不合" });
    expect(replay).toEqual({ ok: true, data: { requestId: first.ok ? first.data.requestId : 0, replayed: true } });
    expect(await app.requestReturn(cookie, { orderId, requestKey: "k1", items: [{ orderLineId: mugLine.id, quantity: 1 }], reason: "尺寸不合" })).toEqual({ ok: false, reason: "request_key_conflict" });

    const mine = await app.getMyOrder(cookie, { orderId });
    if (!mine.ok) throw new Error("讀訂單失敗");
    expect(mine.data.returns).toMatchObject([{ status: "pending", reason: "尺寸不合", items: [{ orderLineId: mugLine.id, quantity: 2, receivedQuantity: null }] }]);
    expect(mine.data.lines.find((line) => line.id === mugLine.id)).toMatchObject({ shippedQuantity: 3, openReturnQuantity: 2, returnedQuantity: 0 });
  });

  it("數量不可超過「已交運且未被其他退貨占用」的數量：重複申請與超量被擋，拒絕後釋出可再申請", async () => {
    const { cookie, orderId, mugLine } = await shippedMixedOrder();
    const first = await requestReturnOk(cookie, orderId, [{ orderLineId: mugLine.id, quantity: 2 }]);

    expect(await requestReturn(cookie, orderId, [{ orderLineId: mugLine.id, quantity: 2 }])).toEqual({ ok: false, reason: "return_quantity_exceeded" });
    expect(await requestReturn(cookie, orderId, [{ orderLineId: mugLine.id, quantity: 1 }])).toMatchObject({ ok: true });

    await decideReturn(first, "reject", "超過期限");
    expect(await requestReturn(cookie, orderId, [{ orderLineId: mugLine.id, quantity: 2 }])).toMatchObject({ ok: true });
  });

  it("並行申請同一批數量只有一個成立", async () => {
    const { cookie, orderId, mugLine } = await shippedMixedOrder();

    const results = await Promise.all([1, 2, 3].map(() => requestReturn(cookie, orderId, [{ orderLineId: mugLine.id, quantity: 3 }])));

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, reason: "return_quantity_exceeded" }, { ok: false, reason: "return_quantity_exceeded" }]);
  });

  it("只有已交運的數量能退：尚未交運的訂單與明細回 order_not_returnable／return_quantity_exceeded；部分出貨只能退已交運的批次", async () => {
    const { cookie, orderId, mugLine, tableLine } = await paidMixedOrder();
    expect(await requestReturn(cookie, orderId, [{ orderLineId: mugLine.id, quantity: 1 }])).toEqual({ ok: false, reason: "order_not_returnable" });

    await shipRemaining(orderId, { items: [{ orderLineId: mugLine.id, quantity: 1 }] });
    expect(await requestReturn(cookie, orderId, [{ orderLineId: mugLine.id, quantity: 2 }])).toEqual({ ok: false, reason: "return_quantity_exceeded" });
    expect(await requestReturn(cookie, orderId, [{ orderLineId: tableLine.id, quantity: 1 }])).toEqual({ ok: false, reason: "return_quantity_exceeded" });
    expect(await requestReturn(cookie, orderId, [{ orderLineId: mugLine.id, quantity: 1 }])).toMatchObject({ ok: true });
  });

  it("別人的訂單與不屬於這張訂單的明細：一律不洩漏", async () => {
    const alice = await shippedMixedOrder("alice");
    const bob = await signInCustomer("bob");
    await requestReturnOk(alice.cookie, alice.orderId, [{ orderLineId: alice.mugLine.id, quantity: 1 }]);

    expect(await requestReturn(bob, alice.orderId, [{ orderLineId: alice.mugLine.id, quantity: 1 }])).toEqual({ ok: false, reason: "order_not_found" });
    expect(await app.getMyOrder(bob, { orderId: alice.orderId })).toEqual({ ok: false, reason: "order_not_found" });
    expect(await requestReturn(alice.cookie, alice.orderId, [{ orderLineId: 999_999, quantity: 1 }])).toEqual({ ok: false, reason: "return_line_invalid" });
    expect(await requestReturn("not-a-session", alice.orderId, [{ orderLineId: alice.mugLine.id, quantity: 1 }])).toEqual({ ok: false, reason: "unauthorized" });
  });

  it("輸入驗證：沒有明細、數量為 0、重複明細都是 invalid_input", async () => {
    const { cookie, orderId, mugLine } = await shippedMixedOrder();

    expect(await requestReturn(cookie, orderId, [])).toMatchObject({ ok: false, reason: "invalid_input" });
    expect(await requestReturn(cookie, orderId, [{ orderLineId: mugLine.id, quantity: 0 }])).toMatchObject({ ok: false, reason: "invalid_input" });
    expect(await requestReturn(cookie, orderId, [{ orderLineId: mugLine.id, quantity: 1 }, { orderLineId: mugLine.id, quantity: 1 }])).toMatchObject({ ok: false, reason: "invalid_input" });
  });
});

describe("審核退貨", () => {
  it("核准與拒絕：留審核人與備註並通知顧客；同一決定重送冪等，相反決定被擋；核准之後（含已收回）重送核准仍是同一決定", async () => {
    const { cookie, orderId, mugLine, tableLine } = await shippedMixedOrder();
    const toApprove = await requestReturnOk(cookie, orderId, [{ orderLineId: mugLine.id, quantity: 1 }]);
    const toReject = await requestReturnOk(cookie, orderId, [{ orderLineId: tableLine.id, quantity: 1 }]);

    expect(await decideReturn(toApprove, "approve", "請寄回")).toEqual({ ok: true, data: { requestId: toApprove, decision: "approved", replayed: false } });
    expect(await decideReturn(toReject, "reject", "已使用")).toMatchObject({ ok: true, data: { decision: "rejected", replayed: false } });
    expect(await decideReturn(toApprove, "approve")).toMatchObject({ ok: true, data: { replayed: true } });
    expect(await decideReturn(toApprove, "reject")).toEqual({ ok: false, reason: "return_already_decided" });
    expect(await decideReturn(toReject, "approve")).toEqual({ ok: false, reason: "return_already_decided" });
    expect(await decideReturn(9999, "approve")).toEqual({ ok: false, reason: "return_not_found" });

    await receiveReturn(toApprove, [{ orderLineId: mugLine.id, receivedQuantity: 1 }]);
    expect(await decideReturn(toApprove, "approve")).toMatchObject({ ok: true, data: { replayed: true } });

    const order = await adminOrder(orderId);
    expect(order.returns).toMatchObject([
      { id: toApprove, status: "received", decidedBy: "admin@example.com", decisionNote: "請寄回" },
      { id: toReject, status: "rejected", decidedBy: "admin@example.com", decisionNote: "已使用" },
    ]);
    expect(await kindsOf(cookie)).toEqual(expect.arrayContaining(["return_approved", "return_rejected"]));
    expect((await kindsOf(cookie)).filter((kind) => kind === "return_approved")).toHaveLength(1);
  });

  it("管理 RPC 沒有有效 JWT 一律 unauthorized", async () => {
    expect(await app.listReturnsToHandle("bad")).toEqual({ ok: false, reason: "unauthorized" });
    expect(await app.decideReturn("bad", { requestId: 1, decision: "approve" })).toEqual({ ok: false, reason: "unauthorized" });
    expect(await app.recordReturnReceipt("bad", { requestId: 1, items: [{ orderLineId: 1, receivedQuantity: 1 }] })).toEqual({ ok: false, reason: "unauthorized" });
    expect(await app.recordReturnInspection("bad", { requestId: 1, items: [{ orderLineId: 1, sellableQuantity: 1, damagedQuantity: 0 }] })).toEqual({ ok: false, reason: "unauthorized" });
    expect(await app.scrapUnavailableStock("bad", { variantId: 1, quantity: 1, reason: "x" })).toEqual({ ok: false, reason: "unauthorized" });
  });
});
