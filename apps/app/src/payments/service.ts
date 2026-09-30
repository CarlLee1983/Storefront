import { drizzle } from "drizzle-orm/d1";
import type { Clock } from "../shared/clock";
import { parseInput } from "../shared/input";
import { fail, ok, type Unauthorized } from "../shared/result";
import { orderIdInput } from "../orders/input";
import { applyPaymentResultInput, confirmPaymentInput } from "./input";
import { diagnoseStart } from "./diagnosis";
import { GatewayError, type GatewayPayment, type PaymentGateway } from "./gateway";
import {
  applyPaymentEvent,
  expirePayment,
  hasPaymentWithStatus,
  insertPaymentIfPayable,
  selectOrderForPayment,
  selectPaymentAndOrderStatus,
  selectPaymentByGatewayId,
  selectPendingPayments,
} from "./queries";
import type { PaymentEvent } from "./shared";

/** 回傳顧客編號；沒有有效 session 回 null。 */
export type AuthenticateCustomer = (cookie: string) => Promise<string | null>;

/**
 * 付款的 service。`gateway` 是 null 表示付款設定不全：需要閘道的 RPC 一律回 `payment_unavailable`（fail closed）。
 * 業務邏輯只依賴 `PaymentGateway` 介面。
 */
export function createPaymentService(
  d1: D1Database,
  clock: Clock,
  authenticate: AuthenticateCustomer,
  gateway: PaymentGateway | null,
  webOrigin: string,
) {
  const db = drizzle(d1);
  const unauthorized: Unauthorized = { ok: false, reason: "unauthorized" };

  async function customerOf(cookie: unknown): Promise<string | null> {
    return typeof cookie === "string" ? authenticate(cookie) : null;
  }

  /** 閘道的失敗（連不上、回錯、格式不符）記一行 log；其他例外照常往上丟。 */
  function logGatewayError(operation: string, error: unknown): void {
    if (!(error instanceof GatewayError)) throw error;
    console.error(JSON.stringify({ event: "payment_gateway_failed", operation, code: error.code, status: error.status }));
  }

  /** 閘道回的金額與商家參照必須與本站記錄一致；不一致記一行 log。 */
  function gatewayResultMatches(queried: GatewayPayment, payment: { amountTwd: number }, orderId: number): boolean {
    if (queried.amountTwd === payment.amountTwd && queried.merchantReference === String(orderId)) return true;
    console.error(JSON.stringify({ event: "payment_gateway_mismatch", orderId, gatewayPaymentId: queried.paymentId }));
    return false;
  }

  /**
   * 套用付款結果（webhook 與導回查詢共用）：以事件 ID 冪等，重複的事件只套用一次、回同一結果。
   * 付款成功落在「已不是待付款」的訂單上（已逾期、已取消，或同一張訂單另一筆付款已先成功）時，付款仍記為成功、訂單不動，
   * 只記一行 `payment_succeeded_on_non_pending_order`：這是 #11（遲到的付款成功重新保留，保留不到或已取消則自動退款）
   * 的接手點，本票不處理。
   */
  async function applyEvent(event: PaymentEvent) {
    const payment = await selectPaymentByGatewayId(db, event.gatewayPaymentId);
    if (!payment) return fail("payment_not_found");

    const { paymentSettled, orderSettled } = await applyPaymentEvent(d1, { ...event, orderId: payment.orderId }, clock.now());
    const current = await selectPaymentAndOrderStatus(db, event.gatewayPaymentId);
    if (!current) return fail("payment_not_found");
    if (event.outcome === "succeeded" && paymentSettled && !orderSettled) {
      console.log(
        JSON.stringify({
          event: "payment_succeeded_on_non_pending_order",
          orderId: payment.orderId,
          gatewayPaymentId: event.gatewayPaymentId,
          orderStatus: current.orderStatus,
        }),
      );
    }
    return ok(current);
  }

  /**
   * 取消不掉的付款（閘道回 409）：向閘道查它現在的狀態，已有結果就用「套用付款結果」套用，回傳 null 表示可以繼續發起新付款；
   * 否則回傳要拒絕的結果。
   * - succeeded：套用（訂單轉已付款），回 `payment_already_succeeded`，不能再發起。
   * - failed：套用，本地轉 failed，繼續。expired：本地轉 expired，繼續。
   * - 其他（仍 pending、金額或參照不符、沒有事件 ID）：`payment_in_progress`；查不到：`payment_gateway_unavailable`。
   */
  async function resolveUncancellable(pending: { id: number; gatewayPaymentId: string; amountTwd: number }, orderId: number) {
    if (!gateway) return fail("payment_unavailable");
    let queried;
    try {
      queried = await gateway.getPayment(pending.gatewayPaymentId);
    } catch (error) {
      logGatewayError("getPayment", error);
      return fail("payment_gateway_unavailable");
    }
    if (!gatewayResultMatches(queried, pending, orderId)) return fail("payment_in_progress");
    if (queried.status === "expired") {
      await expirePayment(db, pending.id);
      return null;
    }
    if ((queried.status === "succeeded" || queried.status === "failed") && queried.eventId) {
      const applied = await applyEvent({ eventId: queried.eventId, gatewayPaymentId: pending.gatewayPaymentId, outcome: queried.status });
      if (!applied.ok) return fail("payment_in_progress");
      return queried.status === "succeeded" ? fail("payment_already_succeeded") : null;
    }
    return fail("payment_in_progress");
  }

  return {
    /**
     * 由 Web Worker 在驗過閘道 webhook 的簽章之後呼叫；App 沒有 HTTP 入口，Service Binding 是唯一的來路，所以這裡沒有顧客身分。
     */
    async applyPaymentResult(input: unknown) {
      const parsed = parseInput(applyPaymentResultInput, input);
      if (!parsed.ok) return parsed;
      return applyEvent(parsed.data);
    },

    /**
     * 顧客付完款被導回時呼叫：向閘道查詢這筆付款的狀態，已有結果就套用（與 webhook 共用同一個動作與事件 ID）。
     * 訂單必須是這位顧客的、付款必須屬於這張訂單；兩種不符對外都不洩漏別人的資料。
     * 閘道回的金額或商家參照與本站不符就拒絕（payment_mismatch）。閘道說已失效（expired）就把本地付款轉 expired；
     * 其他還沒有結果的狀態（pending、已退款，或成功卻沒有事件 ID）不套用，回目前狀態。
     */
    async confirmPayment(cookie: unknown, input: unknown) {
      const customerId = await customerOf(cookie);
      if (!customerId) return unauthorized;
      const parsed = parseInput(confirmPaymentInput, input);
      if (!parsed.ok) return parsed;
      if (!gateway) return fail("payment_unavailable");
      const { orderId, gatewayPaymentId } = parsed.data;

      if (!(await selectOrderForPayment(db, customerId, orderId))) return fail("order_not_found");
      const payment = await selectPaymentByGatewayId(db, gatewayPaymentId);
      if (!payment || payment.orderId !== orderId) return fail("payment_not_found");

      let queried;
      try {
        queried = await gateway.getPayment(gatewayPaymentId);
      } catch (error) {
        logGatewayError("getPayment", error);
        return fail("payment_gateway_unavailable");
      }

      // 閘道回的金額與商家參照必須與本站記錄一致，不一致就不套用（不信任閘道回應與本站訂單對不上的結果）
      if (!gatewayResultMatches(queried, payment, orderId)) return fail("payment_mismatch");
      if ((queried.status === "succeeded" || queried.status === "failed") && queried.eventId) {
        return applyEvent({ eventId: queried.eventId, gatewayPaymentId, outcome: queried.status });
      }
      // 閘道端已失效（顧客沒付、或被取消）：本地不再停在 pending
      if (queried.status === "expired") await expirePayment(db, payment.id);
      const current = await selectPaymentAndOrderStatus(db, gatewayPaymentId);
      return current ? ok(current) : fail("payment_not_found");
    },

    /**
     * 發起付款。流程（每一步都可能因為並行而失效，最後一步的單句條件寫入才是判定）：
     * 1. 診斷：自己的、待付款、未過期、沒有成功付款。
     * 2. 取消同一訂單上本地仍 pending 的付款（閘道取消，成功就把本地轉 expired；閘道端本來就已失效也算成功）。
     *    取消不掉（409：閘道端已經有結果，可能已成功）就查閘道狀態，依結果套用或中止（見 `resolveUncancellable`），避免重複扣款。
     * 3. 在閘道建立付款（失效時間不超過訂單的付款期限），再以條件式 INSERT 記錄：訂單仍待付款、未過期、
     *    沒有成功也沒有其他 pending 的付款才寫入。寫入被擋下（例如另一個分頁搶先）就取消剛建立的閘道付款並回原因。
     */
    async startPayment(cookie: unknown, input: unknown) {
      const customerId = await customerOf(cookie);
      if (!customerId) return unauthorized;
      const parsed = parseInput(orderIdInput, input);
      if (!parsed.ok) return parsed;
      if (!gateway) return fail("payment_unavailable");
      const { orderId } = parsed.data;

      const order = await selectOrderForPayment(db, customerId, orderId);
      if (!order) return fail("order_not_found");
      const refusal = diagnoseStart(order, { hasSucceeded: await hasPaymentWithStatus(db, orderId, "succeeded"), hasPending: false }, clock.now());
      if (refusal) return fail(refusal);

      for (const pending of await selectPendingPayments(db, orderId)) {
        try {
          await gateway.cancel(pending.gatewayPaymentId);
          await expirePayment(db, pending.id);
        } catch (error) {
          logGatewayError("cancel", error);
          if (!(error instanceof GatewayError && error.status === 409)) return fail("payment_gateway_unavailable");
          // 409：閘道端這筆付款已經有結果（甚至可能已成功，只是 webhook 還沒送到）。查它的狀態，不能貿然放行也不能永遠擋著
          const blocked = await resolveUncancellable(pending, orderId);
          if (blocked) return blocked;
        }
      }

      let created;
      try {
        created = await gateway.createPayment({
          merchantReference: String(orderId),
          amountTwd: order.totalTwd,
          returnUrl: `${webOrigin}/orders/${orderId}/payment-return`,
          webhookUrl: `${webOrigin}/api/payments/webhook`,
          expiresAt: order.paymentDeadline,
        });
      } catch (error) {
        logGatewayError("createPayment", error);
        return fail("payment_gateway_unavailable");
      }

      const paymentId = await insertPaymentIfPayable(
        d1,
        { customerId, orderId, gatewayPaymentId: created.paymentId, expiresAt: created.expiresAt },
        clock.now(),
      );
      if (paymentId === null) {
        // 閘道上這筆付款沒有人會用，讓它失效（失敗也無妨，它最晚在付款期限就自己失效）
        try {
          await gateway.cancel(created.paymentId);
        } catch (error) {
          logGatewayError("cancel", error);
        }
        const current = await selectOrderForPayment(db, customerId, orderId);
        const reason = current
          ? diagnoseStart(
              current,
              { hasSucceeded: await hasPaymentWithStatus(db, orderId, "succeeded"), hasPending: await hasPaymentWithStatus(db, orderId, "pending") },
              clock.now(),
            )
          : null;
        // 診斷不出其他原因，就是高水位判定付款期限已到
        return fail(reason ?? "payment_deadline_passed");
      }
      console.log(JSON.stringify({ event: "payment_started", orderId, paymentId }));
      return ok({ paymentId, paymentUrl: created.paymentUrl });
    },
  };
}
