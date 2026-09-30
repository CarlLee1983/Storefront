import { exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { generateRogueKey, mintAccessJwt } from "./access";
import { signInCustomer } from "./customers";
import { forceOrderStatus, resetDb } from "./db";
import { orderOf, placeMugOrder } from "./payment-helpers";

const app = exports.default;

/** 成立一張已付款的訂單，回傳顧客 cookie 與訂單編號。 */
async function paidOrder(name = "alice") {
  const cookie = await signInCustomer(name);
  const { orderId } = await placeMugOrder(cookie);
  await forceOrderStatus(orderId, "paid");
  return { cookie, orderId };
}

async function detailOf(orderId: number) {
  const found = await app.getOrderForAdmin(await mintAccessJwt(), { orderId });
  if (!found.ok) throw new Error(`讀取訂單失敗：${found.reason}`);
  return found.data;
}

describe("管理員出貨", () => {
  beforeEach(resetDb);

  it("已付款的訂單附物流單號出貨：轉為已出貨，記下物流單號（trim）與出貨時間", async () => {
    const { orderId } = await paidOrder();

    const shipped = await app.shipOrder(await mintAccessJwt(), { orderId, trackingNumber: "  TW123456789  " });

    expect(shipped).toEqual({ ok: true, data: { orderId, status: "shipped" } });
    expect(await detailOf(orderId)).toMatchObject({ status: "shipped", trackingNumber: "TW123456789", shippedAt: expect.any(Number) });
  });

  it("不附物流單號也能出貨：省略、空字串、只有空白都記為沒有物流單號", async () => {
    const jwt = await mintAccessJwt();
    const inputs = [{}, { trackingNumber: "" }, { trackingNumber: "   " }];

    for (const extra of inputs) {
      const { orderId } = await paidOrder();
      expect(await app.shipOrder(jwt, { orderId, ...extra })).toEqual({ ok: true, data: { orderId, status: "shipped" } });
      expect(await detailOf(orderId)).toMatchObject({ status: "shipped", trackingNumber: null, shippedAt: expect.any(Number) });
    }
  });

  it("物流單號超過長度上限回 invalid_input，訂單不動", async () => {
    const { orderId } = await paidOrder();

    const result = await app.shipOrder(await mintAccessJwt(), { orderId, trackingNumber: "X".repeat(101) });

    expect(result).toMatchObject({ ok: false, reason: "invalid_input", fields: { trackingNumber: [expect.any(String)] } });
    expect(await detailOf(orderId)).toMatchObject({ status: "paid", trackingNumber: null });
  });

  it.each(["TW\n123", "TW\t123", "TW\u0000123", "單號123"])("物流單號含控制字元或非 ASCII（%j）回 invalid_input，訂單不動", async (trackingNumber) => {
    const { orderId } = await paidOrder();

    const result = await app.shipOrder(await mintAccessJwt(), { orderId, trackingNumber });

    expect(result).toMatchObject({ ok: false, reason: "invalid_input", fields: { trackingNumber: [expect.any(String)] } });
    expect(await detailOf(orderId)).toMatchObject({ status: "paid", trackingNumber: null });
  });

  it("物流單號可含空格與常見符號（可列印 ASCII）", async () => {
    const { orderId } = await paidOrder();

    await app.shipOrder(await mintAccessJwt(), { orderId, trackingNumber: "TW-123_456/AB 7" });

    expect(await detailOf(orderId)).toMatchObject({ trackingNumber: "TW-123_456/AB 7" });
  });

  it.each(["pending_payment", "expired", "cancelled"])("%s 的訂單不能出貨：order_not_shippable，狀態不變", async (status) => {
    const cookie = await signInCustomer("alice");
    const { orderId } = await placeMugOrder(cookie);
    await forceOrderStatus(orderId, status);

    expect(await app.shipOrder(await mintAccessJwt(), { orderId, trackingNumber: "TW1" })).toEqual({ ok: false, reason: "order_not_shippable" });

    expect(await detailOf(orderId)).toMatchObject({ status, trackingNumber: null, shippedAt: null });
  });

  it("已出貨不能再出貨、不能撤回：第二次出貨回 order_not_shippable，物流單號與出貨時間不變", async () => {
    const { orderId } = await paidOrder();
    const jwt = await mintAccessJwt();
    await app.shipOrder(jwt, { orderId, trackingNumber: "FIRST" });
    const before = await detailOf(orderId);

    expect(await app.shipOrder(jwt, { orderId, trackingNumber: "SECOND" })).toEqual({ ok: false, reason: "order_not_shippable" });

    expect(await detailOf(orderId)).toEqual(before);
  });

  it("訂單不存在回 order_not_found；訂單編號無效回 invalid_input", async () => {
    const jwt = await mintAccessJwt();

    expect(await app.shipOrder(jwt, { orderId: 999 })).toEqual({ ok: false, reason: "order_not_found" });
    expect(await app.shipOrder(jwt, { orderId: 0 })).toMatchObject({ ok: false, reason: "invalid_input" });
  });

  it("出貨後顧客在我的訂單與訂單明細都看得到已出貨與物流單號；沒附時為 null", async () => {
    const shippedWith = await paidOrder("alice");
    const shippedWithout = await paidOrder("bob");
    const jwt = await mintAccessJwt();
    await app.shipOrder(jwt, { orderId: shippedWith.orderId, trackingNumber: "TW999" });
    await app.shipOrder(jwt, { orderId: shippedWithout.orderId });

    expect(await orderOf(shippedWith.cookie, shippedWith.orderId)).toMatchObject({ status: "shipped", trackingNumber: "TW999", shippedAt: expect.any(Number) });
    const listed = await app.listMyOrders(shippedWith.cookie);
    expect(listed.ok && listed.data[0]).toMatchObject({ id: shippedWith.orderId, status: "shipped", trackingNumber: "TW999" });
    expect(await orderOf(shippedWithout.cookie, shippedWithout.orderId)).toMatchObject({ status: "shipped", trackingNumber: null });
  });

  it("並行出貨同一張訂單：只有一次成功，另一次 order_not_shippable，記下的是成功那次的物流單號", async () => {
    const { orderId } = await paidOrder();
    const jwt = await mintAccessJwt();

    const results = await Promise.all([
      app.shipOrder(jwt, { orderId, trackingNumber: "A" }),
      app.shipOrder(jwt, { orderId, trackingNumber: "B" }),
    ]);

    const winners = results.flatMap((result, index) => (result.ok ? [index === 0 ? "A" : "B"] : []));
    expect(winners).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, reason: "order_not_shippable" }]);
    expect((await detailOf(orderId)).trackingNumber).toBe(winners[0]);
  });

  it("沒有有效 Access JWT 被拒絕為 unauthorized，訂單不動", async () => {
    const { orderId } = await paidOrder();
    const rogue = await mintAccessJwt({ key: await generateRogueKey() });
    const unauthorized = { ok: false, reason: "unauthorized" };

    expect(await app.shipOrder("", { orderId })).toEqual(unauthorized);
    expect(await app.shipOrder(rogue, { orderId })).toEqual(unauthorized);
    expect(await app.getOrderForAdmin("", { orderId })).toEqual(unauthorized);
    expect(await app.listOrdersForAdmin("", {})).toEqual(unauthorized);

    expect(await detailOf(orderId)).toMatchObject({ status: "paid" });
  });
});
