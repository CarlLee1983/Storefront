import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkoutInput } from "./checkout-helpers";
import { signInCustomer } from "./customers";
import { setNow } from "./clock";
import { TEST_GATEWAY_BASE_URL } from "./constants";
import { forceOrderStatus, resetDb, seedPayment } from "./db";
import { installFakeGateway } from "./fake-gateway";
import { orderOf, placeMugOrder, stockOf } from "./payment-helpers";
import { createPaymentService } from "../src/payments/service";

const app = exports.default;
const WEB_ORIGIN = "http://localhost:4321";
const PAYMENT_WINDOW_MS = 15 * 60 * 1000;
const GATEWAY_PAYMENT_LIFETIME_MS = 10 * 60 * 1000;
const PAYMENT_CUTOFF_MS = 2 * 60 * 1000;

describe("startPayment：發起付款", () => {
  beforeEach(resetDb);
  afterEach(() => vi.restoreAllMocks());

  it("待付款訂單：向閘道建立付款（訂單編號當 merchantReference），記錄一筆待付款的付款，回傳付款頁網址", async () => {
    const alice = await signInCustomer("alice");
    const { orderId, totalTwd } = await placeMugOrder(alice);
    const gateway = installFakeGateway();
    const now = Date.now();
    setNow(now);

    const result = await app.startPayment(alice, { orderId });

    expect(result).toEqual({ ok: true, data: { paymentId: expect.any(Number), paymentUrl: `${TEST_GATEWAY_BASE_URL}/pay/pay_1` } });
    const { paymentDeadline } = await orderOf(alice, orderId);
    expect(gateway.created).toEqual([
      {
        merchantReference: String(orderId),
        amountTwd: totalTwd,
        // 付款期限 15 分鐘、剛發起：取發起後 10 分鐘（比付款期限前 2 分鐘的 13 分鐘早）
        expiresAt: now + GATEWAY_PAYMENT_LIFETIME_MS,
        returnUrl: `${WEB_ORIGIN}/orders/${orderId}/payment-return`,
        webhookUrl: `${WEB_ORIGIN}/api/payments/webhook`,
      },
    ]);
    expect((await orderOf(alice, orderId)).payments).toEqual([
      { id: expect.any(Number), amountTwd: totalTwd, status: "pending", createdAt: now, refundReason: null, refundAt: null, needsAttention: false },
    ]);
  });

  it("先安裝假閘道、之後才登入顧客也行（fetch 替身共用同一個分派器，與安裝順序無關）", async () => {
    const gateway = installFakeGateway();
    const alice = await signInCustomer("alice");
    const { orderId } = await placeMugOrder(alice);

    expect(await app.startPayment(alice, { orderId })).toMatchObject({ ok: true });
    expect(gateway.created).toHaveLength(1);
  });

  it("付款期限前 5 分鐘發起：閘道收到的失效時間是付款期限前 2 分鐘（發起後 10 分鐘與付款期限前 2 分鐘取較早的）", async () => {
    const alice = await signInCustomer("alice");
    const created = Date.now();
    setNow(created);
    const { orderId } = await placeMugOrder(alice);
    const gateway = installFakeGateway();

    setNow(created + PAYMENT_WINDOW_MS - 5 * 60 * 1000);
    expect(await app.startPayment(alice, { orderId })).toMatchObject({ ok: true });

    expect(gateway.created[0]?.expiresAt).toBe(created + PAYMENT_WINDOW_MS - PAYMENT_CUTOFF_MS);
    // 失效時間存在本地付款上：付款期限前 2 分鐘之後顯示為已失效
    setNow(created + PAYMENT_WINDOW_MS - PAYMENT_CUTOFF_MS);
    expect((await orderOf(alice, orderId)).payments).toMatchObject([{ status: "expired" }]);
  });

  it("付款期限前 1 分鐘（付款期限前 2 分鐘內）發起：payment_window_closed，不呼叫閘道也不留付款記錄", async () => {
    const alice = await signInCustomer("alice");
    const created = Date.now();
    setNow(created);
    const { orderId } = await placeMugOrder(alice);
    const gateway = installFakeGateway();

    setNow(created + PAYMENT_WINDOW_MS - 60 * 1000);
    expect(await app.startPayment(alice, { orderId })).toEqual({ ok: false, reason: "payment_window_closed" });

    expect(gateway.created).toEqual([]);
    expect((await orderOf(alice, orderId)).payments).toEqual([]);
  });

  it("付款期限前 2 分鐘整點：關閉；再早 1 毫秒仍可發起", async () => {
    const alice = await signInCustomer("alice");
    const created = Date.now();
    setNow(created);
    const { orderId } = await placeMugOrder(alice);
    installFakeGateway();

    setNow(created + PAYMENT_WINDOW_MS - PAYMENT_CUTOFF_MS);
    expect(await app.startPayment(alice, { orderId })).toEqual({ ok: false, reason: "payment_window_closed" });
    setNow(created + PAYMENT_WINDOW_MS - PAYMENT_CUTOFF_MS - 1);
    expect(await app.startPayment(alice, { orderId })).toMatchObject({ ok: true });
  });

  it("閘道回的失效時間不早於付款期限：視為閘道回應不合法，取消那筆付款，payment_gateway_unavailable，不留付款記錄", async () => {
    const alice = await signInCustomer("alice");
    const { orderId } = await placeMugOrder(alice);
    const gateway = installFakeGateway();
    gateway.expiresAtOverride = (requested) => requested + 10 * 60 * 1000; // 閘道把失效時間延後到付款期限之後

    expect(await app.startPayment(alice, { orderId })).toEqual({ ok: false, reason: "payment_gateway_unavailable" });

    expect(gateway.cancelled).toEqual(["pay_1"]);
    expect((await orderOf(alice, orderId)).payments).toEqual([]);
  });

  it("本地仍是 pending、但已過失效時間的付款，訂單頁顯示為已失效；失效前仍是 pending", async () => {
    const alice = await signInCustomer("alice");
    const created = Date.now();
    setNow(created);
    const { orderId } = await placeMugOrder(alice);
    installFakeGateway();
    await app.startPayment(alice, { orderId });

    setNow(created + 10 * 60 * 1000 - 1);
    expect((await orderOf(alice, orderId)).payments).toMatchObject([{ status: "pending" }]);
    setNow(created + 10 * 60 * 1000);
    expect((await orderOf(alice, orderId)).payments).toMatchObject([{ status: "expired" }]);
  });

  it("再發起一次：先取消同一訂單上進行中的付款（閘道取消、本地轉 expired），再建立新的，最多一筆 pending", async () => {
    const alice = await signInCustomer("alice");
    const { orderId } = await placeMugOrder(alice);
    const gateway = installFakeGateway();

    await app.startPayment(alice, { orderId });
    const first = gateway.lastPaymentId();
    await app.startPayment(alice, { orderId });

    expect(gateway.cancelled).toEqual([first]);
    expect((await orderOf(alice, orderId)).payments).toMatchObject([{ status: "expired" }, { status: "pending" }]);
  });

  it("進行中的付款取消不掉（閘道回 409，可能已經成功）：payment_in_progress，不建立新付款", async () => {
    const alice = await signInCustomer("alice");
    const { orderId } = await placeMugOrder(alice);
    const gateway = installFakeGateway();
    await app.startPayment(alice, { orderId });
    gateway.uncancellable.add(gateway.lastPaymentId());

    expect(await app.startPayment(alice, { orderId })).toEqual({ ok: false, reason: "payment_in_progress" });

    expect(gateway.created).toHaveLength(1);
    expect((await orderOf(alice, orderId)).payments).toMatchObject([{ status: "pending" }]);
  });

  describe("取消不掉（閘道回 409）時查閘道，依它已有的結果處理", () => {
    /** 訂單上有一筆進行中的付款，閘道端它其實已經有結果，所以取消回 409。 */
    async function withUncancellablePayment() {
      const alice = await signInCustomer("alice");
      const { orderId, variantId } = await placeMugOrder(alice, { onHand: 10, quantity: 2 });
      const gateway = installFakeGateway();
      await app.startPayment(alice, { orderId });
      const old = gateway.lastPaymentId();
      gateway.uncancellable.add(old);
      return { alice, orderId, variantId, gateway, old };
    }

    it("閘道說它已失敗（webhook 沒送到）：本地轉 failed，繼續發起新付款", async () => {
      const { alice, orderId, gateway, old } = await withUncancellablePayment();
      gateway.settle(old, "failed");

      const result = await app.startPayment(alice, { orderId });

      expect(result).toMatchObject({ ok: true });
      expect(gateway.created).toHaveLength(2);
      expect((await orderOf(alice, orderId)).payments).toMatchObject([{ status: "failed" }, { status: "pending" }]);
    });

    it("閘道說它已失效（expired）：本地轉 expired，繼續發起新付款", async () => {
      const { alice, orderId, gateway, old } = await withUncancellablePayment();
      gateway.payments.get(old)!.status = "expired";

      expect(await app.startPayment(alice, { orderId })).toMatchObject({ ok: true });

      expect((await orderOf(alice, orderId)).payments).toMatchObject([{ status: "expired" }, { status: "pending" }]);
    });

    it("閘道說它已成功（webhook 沒送到）：套用結果（訂單轉已付款、在庫數扣除），回 payment_already_succeeded，不建立新付款", async () => {
      const { alice, orderId, variantId, gateway, old } = await withUncancellablePayment();
      gateway.settle(old, "succeeded");

      expect(await app.startPayment(alice, { orderId })).toEqual({ ok: false, reason: "payment_already_succeeded" });

      expect(gateway.created).toHaveLength(1);
      const order = await orderOf(alice, orderId);
      expect(order.status).toBe("paid");
      expect(order.payments).toMatchObject([{ status: "succeeded" }]);
      expect(await stockOf(variantId)).toEqual({ onHand: 8, available: 8 });
    });

    it("閘道回的金額與本站不符：不套用，payment_in_progress，不建立新付款", async () => {
      const { alice, orderId, gateway, old } = await withUncancellablePayment();
      gateway.settle(old, "succeeded");
      gateway.payments.get(old)!.amountTwd = 1;

      expect(await app.startPayment(alice, { orderId })).toEqual({ ok: false, reason: "payment_in_progress" });

      expect((await orderOf(alice, orderId)).status).toBe("pending_payment");
      expect(gateway.created).toHaveLength(1);
    });

    it("查閘道也失敗：payment_gateway_unavailable，不建立新付款", async () => {
      const { alice, orderId, gateway } = await withUncancellablePayment();
      gateway.failNext("get");

      expect(await app.startPayment(alice, { orderId })).toEqual({ ok: false, reason: "payment_gateway_unavailable" });

      expect(gateway.created).toHaveLength(1);
    });
  });

  it("取消進行中付款時連不上閘道：payment_gateway_unavailable，不建立新付款", async () => {
    const alice = await signInCustomer("alice");
    const { orderId } = await placeMugOrder(alice);
    const gateway = installFakeGateway();
    await app.startPayment(alice, { orderId });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new TypeError("fetch failed");
    });

    expect(await app.startPayment(alice, { orderId })).toEqual({ ok: false, reason: "payment_gateway_unavailable" });

    expect(gateway.created).toHaveLength(1);
  });

  it("兩個分頁同時按「前往付款」（Promise.all）：恰好一個成功，閘道上多出來的那筆被取消，本地只有一筆 pending", async () => {
    const alice = await signInCustomer("alice");
    const { orderId } = await placeMugOrder(alice);
    const gateway = installFakeGateway();
    // 讓兩個請求都通過「取消進行中付款」那一步、都在閘道建立了付款之後，才一起去寫本地記錄：
    // 這樣爭的就是條件式 INSERT（若後到的請求在先到的寫入之後才開始，它會改為取消先到的那筆，那是另一個情境，見上一個測試）
    let arrived = 0;
    let release!: () => void;
    const bothCreated = new Promise<void>((resolve) => (release = resolve));
    gateway.onCreate = async () => {
      arrived += 1;
      if (arrived === 2) release();
      await bothCreated;
    };

    const results = await Promise.all([app.startPayment(alice, { orderId }), app.startPayment(alice, { orderId })]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, reason: "payment_in_progress" }]);
    expect(gateway.created).toHaveLength(2);
    const winner = (await orderOf(alice, orderId)).payments;
    expect(winner).toMatchObject([{ status: "pending" }]);
    expect(gateway.cancelled).toHaveLength(1);
    const pendingAtGateway = [...gateway.payments.values()].filter((payment) => payment.status === "pending");
    expect(pendingAtGateway).toHaveLength(1);
  });

  it("別人的訂單：order_not_found，不呼叫閘道也不記錄付款", async () => {
    const alice = await signInCustomer("alice");
    const bob = await signInCustomer("bob");
    const { orderId } = await placeMugOrder(alice);
    const gateway = installFakeGateway();

    expect(await app.startPayment(bob, { orderId })).toEqual({ ok: false, reason: "order_not_found" });

    expect(gateway.created).toEqual([]);
    expect((await orderOf(alice, orderId)).payments).toEqual([]);
  });

  it("訂單不存在：order_not_found", async () => {
    const alice = await signInCustomer("alice");
    installFakeGateway();

    expect(await app.startPayment(alice, { orderId: 9999 })).toEqual({ ok: false, reason: "order_not_found" });
  });

  it.each(["paid", "shipped", "expired", "cancelled"])("訂單是 %s（不是待付款）：order_not_payable，不呼叫閘道", async (status) => {
    const alice = await signInCustomer("alice");
    const { orderId } = await placeMugOrder(alice);
    await forceOrderStatus(orderId, status);
    const gateway = installFakeGateway();

    expect(await app.startPayment(alice, { orderId })).toEqual({ ok: false, reason: "order_not_payable" });

    expect(gateway.created).toEqual([]);
  });

  it("超過付款期限（Cron 還沒把訂單轉逾期）：payment_deadline_passed，不呼叫閘道；期限前一毫秒仍可付款", async () => {
    const alice = await signInCustomer("alice");
    const created = Date.now();
    setNow(created);
    const { orderId } = await placeMugOrder(alice);
    const gateway = installFakeGateway();

    setNow(created + PAYMENT_WINDOW_MS);
    expect(await app.startPayment(alice, { orderId })).toEqual({ ok: false, reason: "payment_deadline_passed" });
    expect(gateway.created).toEqual([]);

    setNow(created + PAYMENT_WINDOW_MS - PAYMENT_CUTOFF_MS - 1);
    expect(await app.startPayment(alice, { orderId })).toMatchObject({ ok: true });
  });

  it("付款期限以高水位時鐘判定：系統時鐘倒退也不能讓已逾期的訂單再付款，閘道上多出來的付款被取消", async () => {
    const alice = await signInCustomer("alice");
    const created = Date.now();
    setNow(created);
    const { orderId, variantId } = await placeMugOrder(alice);
    // 另一位顧客在期限之後結帳，把高水位推到期限之後
    const bob = await signInCustomer("bob");
    setNow(created + PAYMENT_WINDOW_MS + 1_000);
    await app.checkout(bob, checkoutInput([{ variantId, quantity: 1, seenUnitPriceTwd: 320 }]));
    const gateway = installFakeGateway();

    setNow(created + 1_000); // 系統時鐘倒退
    expect(await app.startPayment(alice, { orderId })).toEqual({ ok: false, reason: "payment_deadline_passed" });

    expect((await orderOf(alice, orderId)).payments).toEqual([]);
    expect(gateway.cancelled).toEqual(gateway.created.map((_, index) => `pay_${index + 1}`));
    expect(gateway.cancelled).toHaveLength(1);
  });

  it("呼叫閘道期間訂單被轉走（例如剛好被取消）：order_not_payable，不留付款記錄，閘道上的付款被取消", async () => {
    const alice = await signInCustomer("alice");
    const { orderId } = await placeMugOrder(alice);
    const gateway = installFakeGateway();
    gateway.onCreate = () => forceOrderStatus(orderId, "cancelled");

    expect(await app.startPayment(alice, { orderId })).toEqual({ ok: false, reason: "order_not_payable" });

    expect((await orderOf(alice, orderId)).payments).toEqual([]);
    expect(gateway.cancelled).toEqual(["pay_1"]);
  });

  it("訂單已有成功的付款：payment_already_succeeded，不呼叫閘道", async () => {
    const alice = await signInCustomer("alice");
    const { orderId } = await placeMugOrder(alice);
    await seedPayment(orderId, "succeeded");
    const gateway = installFakeGateway();

    expect(await app.startPayment(alice, { orderId })).toEqual({ ok: false, reason: "payment_already_succeeded" });

    expect(gateway.created).toEqual([]);
  });

  it.each([
    ["閘道回 502", 502],
    ["連不上閘道", 0],
  ])("%s：payment_gateway_unavailable，不留付款記錄", async (_label, status) => {
    const alice = await signInCustomer("alice");
    const { orderId } = await placeMugOrder(alice);
    const gateway = installFakeGateway();
    gateway.failNext("create", status);

    expect(await app.startPayment(alice, { orderId })).toEqual({ ok: false, reason: "payment_gateway_unavailable" });

    expect((await orderOf(alice, orderId)).payments).toEqual([]);
  });

  it("沒有 session：unauthorized，不呼叫閘道", async () => {
    const alice = await signInCustomer("alice");
    const { orderId } = await placeMugOrder(alice);
    const gateway = installFakeGateway();

    expect(await app.startPayment("", { orderId })).toEqual({ ok: false, reason: "unauthorized" });

    expect(gateway.created).toEqual([]);
  });

  it.each([
    ["缺 orderId", {}],
    ["orderId 不是整數", { orderId: 1.5 }],
    ["orderId 是字串", { orderId: "1" }],
  ])("輸入不合法（%s）：invalid_input", async (_label, input) => {
    const alice = await signInCustomer("alice");
    installFakeGateway();

    expect(await app.startPayment(alice, input)).toMatchObject({ ok: false, reason: "invalid_input" });
  });

  it("閘道尚未設定（缺 URL 或金鑰）：payment_unavailable，fail closed", async () => {
    const service = createPaymentService(
      // 不該碰到資料庫：設定檢查在最前面
      {} as D1Database,
      { now: () => Date.now() },
      async () => "someone",
      null,
      WEB_ORIGIN,
    );

    expect(await service.startPayment("cookie", { orderId: 1 })).toEqual({ ok: false, reason: "payment_unavailable" });
  });
});
