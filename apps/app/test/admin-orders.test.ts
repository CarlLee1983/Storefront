import { env, exports } from "cloudflare:workers";
import { desc } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { orderFilterWhere } from "../src/orders/admin-queries";
import { orders } from "../src/orders/schema";
import { beforeEach, describe, expect, it } from "vitest";
import { mintAccessJwt } from "./access";
import { signInCustomer } from "./customers";
import { checkoutInput, createStockedListing, SHIPPING_INFO } from "./checkout-helpers";
import { forceOrderCreatedAt, forceOrderStatus, resetDb, seedPayment } from "./db";
import { placeMugOrder } from "./payment-helpers";

const app = exports.default;

describe("管理員訂單清單", () => {
  beforeEach(resetDb);

  it("沒有任何訂單時回空清單", async () => {
    expect(await app.listOrdersForAdmin(await mintAccessJwt(), {})).toEqual({ ok: true, data: { items: [], nextBeforeId: null } });
  });

  it("列出所有顧客的訂單，新的在前，含顧客 email、總金額、狀態與成立時間", async () => {
    const alice = await signInCustomer("alice");
    const bob = await signInCustomer("bob");
    const first = await placeMugOrder(alice, { quantity: 2 });
    const second = await placeMugOrder(bob, { quantity: 1 });

    const result = await app.listOrdersForAdmin(await mintAccessJwt(), {});

    expect(result).toEqual({
      ok: true,
      data: { nextBeforeId: null, items: [
        { id: second.orderId, status: "pending_payment", totalTwd: 420, customerEmail: "bob@example.com", createdAt: expect.any(Number), needsAttention: false, lines: [expect.objectContaining({ cover: expect.objectContaining({ id: expect.any(String) }) })] },
        { id: first.orderId, status: "pending_payment", totalTwd: 740, customerEmail: "alice@example.com", createdAt: expect.any(Number), needsAttention: false, lines: [expect.objectContaining({ cover: expect.objectContaining({ id: expect.any(String) }) })] },
      ] },
    });
  });

  it("翻頁走過全部訂單：每頁 20 筆、不遺漏不重複，每筆都有明細與封面，超過 100 張仍可讀取", async () => {
    const cookie = await signInCustomer("alice");
    const { productId, variantId } = await createStockedListing("大量訂單商品", 100, 105);
    const ids: number[] = [];
    for (let index = 0; index < 105; index++) {
      const placed = await app.checkout(cookie, checkoutInput([{ variantId, quantity: 1, seenUnitPriceTwd: 100 }]));
      if (!placed.ok) throw new Error(`結帳失敗：${placed.reason}`);
      ids.push(placed.data.orderId);
    }
    const jwt = await mintAccessJwt();

    const seen: number[] = [];
    let beforeId: number | undefined;
    let pages = 0;
    do {
      const page = await app.listOrdersForAdmin(jwt, beforeId === undefined ? {} : { beforeId });
      if (!page.ok) throw new Error("讀取清單失敗");
      pages++;
      expect(page.data.items.length).toBeLessThanOrEqual(20);
      for (const order of page.data.items) {
        expect(order.lines).toEqual([{ id: expect.any(Number), productId, variantId, productName: "大量訂單商品", variantLabel: "", quantity: 1, unitPriceTwd: 100, deliveryType: "standard", shippedQuantity: 0, cancelledQuantity: 0, pendingCancellationQuantity: 0, returnedQuantity: 0, openReturnQuantity: 0, lostQuantity: 0, shipmentReturnedQuantity: 0,
          cover: expect.objectContaining({ id: expect.any(String), variants: expect.any(Array) }) }]);
      }
      seen.push(...page.data.items.map(order => order.id));
      beforeId = page.data.nextBeforeId ?? undefined;
    } while (beforeId !== undefined);

    expect(pages).toBe(6);
    expect(seen).toEqual([...ids].reverse());
  }, 60_000);

  it("翻頁期間新增的訂單不造成舊單重複或遺漏", async () => {
    const alice = await signInCustomer("alice");
    const ids: number[] = [];
    for (let index = 0; index < 22; index++) ids.push((await placeMugOrder(alice, { onHand: 100, quantity: 1 })).orderId);
    const jwt = await mintAccessJwt();

    const first = await app.listOrdersForAdmin(jwt, {});
    await placeMugOrder(alice, { onHand: 100, quantity: 1 });
    if (!first.ok || first.data.nextBeforeId === null) throw new Error("第一頁應有下一頁");
    const second = await app.listOrdersForAdmin(jwt, { beforeId: first.data.nextBeforeId });

    expect(second.ok && second.data.items.map(order => order.id)).toEqual([ids[1], ids[0]]);
  }, 60_000);

  it("依訂單狀態篩選；狀態值無效回 invalid_input", async () => {
    const alice = await signInCustomer("alice");
    const pending = await placeMugOrder(alice);
    const paid = await placeMugOrder(alice);
    await forceOrderStatus(paid.orderId, "paid");
    const jwt = await mintAccessJwt();

    const onlyPaid = await app.listOrdersForAdmin(jwt, { status: "paid" });
    const onlyPending = await app.listOrdersForAdmin(jwt, { status: "pending_payment" });
    const noneShipped = await app.listOrdersForAdmin(jwt, { status: "shipped" });

    expect(onlyPaid.ok && onlyPaid.data.items.map((order) => order.id)).toEqual([paid.orderId]);
    expect(onlyPending.ok && onlyPending.data.items.map((order) => order.id)).toEqual([pending.orderId]);
    expect(noneShipped).toEqual({ ok: true, data: { items: [], nextBeforeId: null } });
    expect(await app.listOrdersForAdmin(jwt, { status: "mystery" })).toMatchObject({ ok: false, reason: "invalid_input" });
  });
});

describe("查找舊單與匯出（條件一致）", () => {
  beforeEach(resetDb);

  const DAY = 24 * 60 * 60 * 1000;
  // 台北 2030-03-10 12:00
  const MARCH_10 = Date.parse("2030-03-10T12:00:00+08:00");

  async function seedThree() {
    const alice = await signInCustomer("alice");
    const bob = await signInCustomer("bob");
    const a = await placeMugOrder(alice, { onHand: 100, quantity: 1 });
    const b = await placeMugOrder(bob, { onHand: 100, quantity: 1 });
    const c = await placeMugOrder(alice, { onHand: 100, quantity: 1 });
    await forceOrderCreatedAt(a.orderId, MARCH_10 - 5 * DAY);
    await forceOrderCreatedAt(b.orderId, MARCH_10);
    await forceOrderCreatedAt(c.orderId, MARCH_10 + 5 * DAY);
    await forceOrderStatus(b.orderId, "paid");
    return { a: a.orderId, b: b.orderId, c: c.orderId };
  }

  const listedIds = async (filter: object) => {
    const result = await app.listOrdersForAdmin(await mintAccessJwt(), filter);
    return result.ok ? result.data.items.map(order => order.id) : result;
  };
  const exportedIds = async (filter: object) => {
    const result = await app.exportOrdersForAdmin(await mintAccessJwt(), filter);
    return result.ok ? result.data.rows.map(row => row.id) : result;
  };

  it("依訂單編號找單筆，不存在回空", async () => {
    const { b } = await seedThree();

    expect(await listedIds({ orderId: b })).toEqual([b]);
    expect(await listedIds({ orderId: 9999 })).toEqual([]);
  });

  it("依顧客 email 片段找（不分大小寫、%與_ 不當樣式）", async () => {
    const { a, b, c } = await seedThree();

    expect(await listedIds({ email: "ALICE@" })).toEqual([c, a]);
    expect(await listedIds({ email: "bob" })).toEqual([b]);
    expect(await listedIds({ email: "%" })).toEqual([]);
    expect(await listedIds({ email: "a_ice" })).toEqual([]);
  });

  it("依成立日期區間（台北時間，含起訖兩天）找", async () => {
    const { a, b, c } = await seedThree();

    expect(await listedIds({ from: "2030-03-10", to: "2030-03-10" })).toEqual([b]);
    expect(await listedIds({ from: "2030-03-05" })).toEqual([c, b, a]);
    expect(await listedIds({ to: "2030-03-10" })).toEqual([b, a]);
    expect(await listedIds({ from: "2030-03-11", to: "2030-03-31" })).toEqual([c]);
  });

  it("條件可以組合；日期不存在或起訖顛倒回 invalid_input", async () => {
    const { a, c } = await seedThree();

    expect(await listedIds({ email: "alice", to: "2030-03-10" })).toEqual([a]);
    expect(await listedIds({ email: "alice", status: "pending_payment", from: "2030-03-11" })).toEqual([c]);
    expect(await listedIds({ from: "2030-02-30" })).toMatchObject({ ok: false, reason: "invalid_input" });
    expect(await listedIds({ from: "2030-03-11", to: "2030-03-10" })).toMatchObject({ ok: false, reason: "invalid_input" });
    expect(await listedIds({ orderId: 0 })).toMatchObject({ ok: false, reason: "invalid_input" });
  });

  it("只給日期區間時走主鍵範圍，不讀完整區間、也不另外排序", async () => {
    await seedThree();
    const { sql, params } = drizzle(env.DB).select({ id: orders.id }).from(orders).where(orderFilterWhere({ from: MARCH_10 - DAY, to: MARCH_10 + DAY })).orderBy(desc(orders.id)).limit(21).toSQL();

    const plan = (await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...params).all<{ detail: string }>()).results.map(row => row.detail);

    expect(plan.some(detail => /SEARCH orders USING INTEGER PRIMARY KEY/.test(detail)), plan.join("\n")).toBe(true);
    expect(plan.some(detail => /TEMP B-TREE/.test(detail)), plan.join("\n")).toBe(false);
  });

  it("匯出與列表用同一份條件，範圍一致", async () => {
    await seedThree();

    for (const filter of [{}, { email: "alice" }, { status: "paid" }, { from: "2030-03-06" }, { orderId: 1 }, { email: "bob", to: "2030-03-10" }]) {
      expect(await exportedIds(filter), JSON.stringify(filter)).toEqual(await listedIds(filter));
    }
  });

  it("匯出分批：500 筆一批，游標逐批取回 520 筆不遺漏、不重複，與列表範圍相同", async () => {
    await signInCustomer("alice");
    const customer = await env.DB.prepare("SELECT id FROM user LIMIT 1").first<{ id: string }>();
    await env.DB.prepare(`INSERT INTO orders (customer_id, status, total_twd, shipping_name, shipping_phone, shipping_address, payment_deadline, created_at, idempotency_key, request_hash)
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 520)
      SELECT ?, 'paid', 100, 'n', 'p', 'a', 1, i, 'key' || i, 'h' FROM n`).bind(customer!.id).run();
    const jwt = await mintAccessJwt();

    const first = await app.exportOrdersForAdmin(jwt, {});
    if (!first.ok || first.data.nextBeforeId === null) throw new Error("第一批應有下一批");
    const second = await app.exportOrdersForAdmin(jwt, { beforeId: first.data.nextBeforeId });
    if (!second.ok) throw new Error("第二批失敗");

    expect(first.data.rows).toHaveLength(500);
    expect(second.data).toMatchObject({ nextBeforeId: null });
    const ids = [...first.data.rows, ...second.data.rows].map(row => row.id);
    expect(new Set(ids).size).toBe(520);
    expect(ids).toEqual([...ids].sort((x, y) => y - x));
    expect(ids.slice(0, 20)).toEqual((await listedIds({ status: "paid" })) as number[]);
  }, 60_000);

  it("匯出列含付款、出貨、取消、退款、發票等進度彙總", async () => {
    const alice = await signInCustomer("alice");
    const { orderId } = await placeMugOrder(alice, { quantity: 2 });
    await seedPayment(orderId, "succeeded", "seed_ok", 740);

    const result = await app.exportOrdersForAdmin(await mintAccessJwt(), { orderId });

    expect(result).toEqual({
      ok: true,
      data: {
        nextBeforeId: null,
        rows: [{
          id: orderId, createdAt: expect.any(Number), customerEmail: "alice@example.com", status: "pending_payment", totalTwd: 740, needsAttention: true,
          paidTwd: 740, refundedTwd: 0, orderedQuantity: 2, shippedQuantity: 0, cancelledQuantity: 0, returnedQuantity: 0, lostQuantity: 0, shipmentReturnedQuantity: 0,
          invoiceNumbers: "", pendingAllowances: 0,
        }],
      },
    });
  });
});

describe("客服備註", () => {
  beforeEach(resetDb);

  it("管理員新增備註，訂單明細依序列出，留下操作者與時間", async () => {
    const alice = await signInCustomer("alice");
    const { orderId } = await placeMugOrder(alice);
    const jwt = await mintAccessJwt();

    expect(await app.addOrderNote(jwt, { orderId, note: "  電話確認過地址  " })).toEqual({ ok: true, data: { id: expect.any(Number) } });
    expect(await app.addOrderNote(jwt, { orderId, note: "顧客改約週六" })).toMatchObject({ ok: true });

    const order = await app.getOrderForAdmin(jwt, { orderId });
    expect(order).toMatchObject({
      ok: true,
      data: { notes: [
        { id: expect.any(Number), actor: "admin@example.com", note: "電話確認過地址", createdAt: expect.any(Number) },
        { id: expect.any(Number), actor: "admin@example.com", note: "顧客改約週六", createdAt: expect.any(Number) },
      ] },
    });
  });

  it("換行以 \\n 計（瀏覽器的 \\r\\n 不多算），首尾空白去掉，超過 1000 字回 invalid_input", async () => {
    const alice = await signInCustomer("alice");
    const { orderId } = await placeMugOrder(alice);
    const jwt = await mintAccessJwt();

    expect(await app.addOrderNote(jwt, { orderId, note: "字\r\n".repeat(500).trimEnd() })).toMatchObject({ ok: true });
    expect(await app.addOrderNote(jwt, { orderId, note: "\r\n第一行\r\n第二行\r\n" })).toMatchObject({ ok: true });
    expect(await app.addOrderNote(jwt, { orderId, note: "字\r\n".repeat(501).trimEnd() })).toMatchObject({ ok: false, reason: "invalid_input" });
    const order = await app.getOrderForAdmin(jwt, { orderId });
    expect(order.ok && order.data.notes.map(note => note.note.length)).toEqual([999, 7]);
    expect(order.ok && order.data.notes[1]!.note).toBe("第一行\n第二行");
  });

  it("訂單不存在回 order_not_found；空白或過長的備註回 invalid_input，都不寫入", async () => {
    const alice = await signInCustomer("alice");
    const { orderId } = await placeMugOrder(alice);
    const jwt = await mintAccessJwt();

    expect(await app.addOrderNote(jwt, { orderId: 999, note: "x" })).toEqual({ ok: false, reason: "order_not_found" });
    expect(await app.addOrderNote(jwt, { orderId, note: "   " })).toMatchObject({ ok: false, reason: "invalid_input" });
    expect(await app.addOrderNote(jwt, { orderId, note: "字".repeat(1001) })).toMatchObject({ ok: false, reason: "invalid_input" });
    expect(await app.getOrderForAdmin(jwt, { orderId })).toMatchObject({ ok: true, data: { notes: [] } });
  });

  it("顧客端的訂單讀取看不到備註", async () => {
    const alice = await signInCustomer("alice");
    const { orderId } = await placeMugOrder(alice);
    await app.addOrderNote(await mintAccessJwt(), { orderId, note: "內部備註機密字串" });

    const mine = await app.getMyOrder(alice, { orderId });
    const list = await app.listMyOrders(alice);

    expect(mine.ok).toBe(true);
    expect(JSON.stringify(mine)).not.toContain("內部備註機密字串");
    expect(JSON.stringify(mine)).not.toContain("notes");
    expect(JSON.stringify(list)).not.toContain("內部備註機密字串");
  });
});

describe("管理員訂單明細", () => {
  beforeEach(resetDb);

  it("含訂單明細快照、收件資訊、顧客 email、所有付款嘗試，尚未出貨時沒有出貨批次", async () => {
    const alice = await signInCustomer("alice");
    const { orderId, productId, variantId } = await placeMugOrder(alice, { quantity: 2 });
    await seedPayment(orderId, "failed", "seed_failed");
    await seedPayment(orderId, "succeeded", "seed_ok");

    const result = await app.getOrderForAdmin(await mintAccessJwt(), { orderId });

    expect(result).toEqual({
      ok: true,
      data: {
        id: orderId,
        status: "pending_payment",
        totalTwd: 740,
        shippingFees: { standard: 100, large: 0 },
        customerEmail: "alice@example.com",
        shippingInfo: SHIPPING_INFO,
        paymentDeadline: expect.any(Number),
        createdAt: expect.any(Number),
        lines: [{ id: expect.any(Number), productId, variantId, productName: "馬克杯", variantLabel: "", quantity: 2, unitPriceTwd: 320, deliveryType: "standard", shippedQuantity: 0, cancelledQuantity: 0, pendingCancellationQuantity: 0, returnedQuantity: 0, openReturnQuantity: 0, lostQuantity: 0, shipmentReturnedQuantity: 0, cover: expect.objectContaining({ id: expect.any(String), variants: expect.any(Array) }) }],
        payments: [
          { id: expect.any(Number), amountTwd: 1, status: "failed", createdAt: 0, needsAttention: false },
          // 待付款的訂單上有成功的付款：不是由它支付的，也沒有退款紀錄
          { id: expect.any(Number), amountTwd: 1, status: "succeeded", createdAt: 0, needsAttention: true },
        ],
        refunds: [],
        // 直接寫入的付款沒有走「套用付款結果」，所以沒有開立義務
        invoices: [],
        cancellations: [],
        returns: [],
        losses: [],
        shipmentReturns: [],
        shipments: [],
        notes: [],
        timeline: { events: [expect.objectContaining({ kind: "order_placed", refId: orderId })], progress: expect.objectContaining({ flags: [] }), todos: [expect.objectContaining({ kind: "payment_attention", href: `/admin/orders/${orderId}#payments` })] },
      },
    });
  });

  it("訂單不存在回 order_not_found；訂單編號無效回 invalid_input", async () => {
    const jwt = await mintAccessJwt();

    expect(await app.getOrderForAdmin(jwt, { orderId: 999 })).toEqual({ ok: false, reason: "order_not_found" });
    expect(await app.getOrderForAdmin(jwt, { orderId: "abc" })).toMatchObject({ ok: false, reason: "invalid_input" });
  });
});
