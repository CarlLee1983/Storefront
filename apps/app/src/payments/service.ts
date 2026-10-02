import { drizzle } from "drizzle-orm/d1";
import type { Clock } from "../shared/clock";
import { parseInput } from "../shared/input";
import { fail, ok, type Unauthorized } from "../shared/result";
import { orderIdInput } from "../orders/input";
import type { OrderStatus } from "../orders/schema";
import type { PaymentStatus } from "./schema";
import { applyPaymentResultInput, confirmPaymentInput } from "./input";
import { diagnoseStart } from "./diagnosis";
import { GatewayError, type GatewayPayment, type PaymentGateway } from "./gateway";
import {
  applyPaymentEvent,
  expirePayment,
  hasPaymentWithStatus,
  insertPaymentIfPayable,
  selectOrderForPayment,
  selectHighWaterMark,
  selectPaymentAndOrderStatus,
  selectPaymentByGatewayId,
  recordRefundResult,
  selectPendingPayments,
} from "./queries";
import { deliverNoticeSafely } from "../contact/notify";
import { paymentExpiresAt } from "../orders/payment-deadline";
import { refundReasonFor } from "./refund";
import { paymentExists, recordReconcileIssue, resolveReconcileIssue, selectDuePayments, selectPendingPaymentById, type PaymentToReconcile } from "./reconcile";
import type { PaymentEvent, ReconcileIssueReason } from "./shared";

/** 一筆付款補查的結果：套用了閘道的終局結果、閘道端已失效、閘道說還在等待，或沒能確認結果（記為待辦）。 */
export type ReconcileOutcome =
  | { outcome: "settled"; paymentStatus: PaymentStatus; orderStatus: OrderStatus }
  | { outcome: "expired" }
  | { outcome: "waiting" }
  | { outcome: "issue"; reason: ReconcileIssueReason };

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
   * 付款成功、但訂單沒有因它轉為已付款時的退款（原因見 `refundReasonFor`）。`orderStatus` 是套用的 batch 當下讀到的訂單狀態。
   * 只會由「搶到事件、且這次呼叫讓付款轉為成功」的那一次呼叫進來，所以事件重送不會重複退款。
   * 閘道退款在 batch 之外呼叫，結果記在付款上：成功 → refunded，失敗 → refund_failed（連同原因與時間）。
   * 失敗只記錄與結構化 log，不自動重試，也沒有手動退款的操作；後台訂單的「需要處理」會標出 refund_failed 的付款（閘道退款是冪等的，
   * 之後要補退款時再呼叫同一個閘道操作是安全的）。
   */
  async function refundUnsettledPayment(payment: { orderId: number; gatewayPaymentId: string }, orderStatus: OrderStatus) {
    const { orderId, gatewayPaymentId } = payment;
    const reason = refundReasonFor(orderStatus);
    if (!reason) {
      console.error(JSON.stringify({ event: "payment_refund_skipped", orderId, gatewayPaymentId, orderStatus }));
      return;
    }
    let status: "refunded" | "refund_failed" = "refunded";
    if (!gateway) {
      status = "refund_failed";
      console.error(JSON.stringify({ event: "payment_refund_failed", orderId, gatewayPaymentId, reason, code: "payment_unavailable" }));
    } else {
      try {
        await gateway.refund(gatewayPaymentId);
      } catch (error) {
        logGatewayError("refund", error);
        status = "refund_failed";
        console.error(JSON.stringify({ event: "payment_refund_failed", orderId, gatewayPaymentId, reason }));
      }
    }
    if (!(await recordRefundResult(d1, gatewayPaymentId, { status, reason }, clock.now()))) {
      // 付款在退款期間已不是 succeeded：結果沒有寫進去，不能記成已退款
      console.error(JSON.stringify({ event: "payment_refund_unrecorded", orderId, gatewayPaymentId, reason }));
      return;
    }
    if (status === "refunded") console.log(JSON.stringify({ event: "payment_refunded", orderId, gatewayPaymentId, reason }));
  }

  /**
   * 套用付款結果（webhook 與導回查詢共用）：以事件 ID 冪等，重複的事件只套用一次、回同一結果。
   * 付款結果通知的信件與付款結果同一個 batch 寫入（outbox，見 `contact/notices.ts`）；batch 之後才投遞，投遞出錯只記 log，
   * 付款不受影響，事件重送時補上缺的投遞。
   * 付款成功時的分流在 `applyPaymentEvent`（待付款轉已付款、已逾期重新保留）；沒能讓訂單轉為已付款的成功付款
   * （重新保留不到、已取消、第二筆成功）由搶到事件的這次呼叫退款。回傳的是退款記錄之後的付款與訂單狀態。
   */
  async function applyEvent(event: PaymentEvent) {
    const payment = await selectPaymentByGatewayId(db, event.gatewayPaymentId);
    if (!payment) return fail("payment_not_found");

    const { paymentSettled, orderSettled, orderStatus } = await applyPaymentEvent(d1, { ...event, orderId: payment.orderId }, clock.now());
    if (event.outcome === "succeeded" && paymentSettled && !orderSettled) {
      await refundUnsettledPayment({ orderId: payment.orderId, gatewayPaymentId: event.gatewayPaymentId }, orderStatus);
    }
    await deliverNoticeSafely(db, `payment:${payment.id}`, clock.now());
    const current = await selectPaymentAndOrderStatus(db, event.gatewayPaymentId);
    return current ? ok(current) : fail("payment_not_found");
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

  /**
   * 讓這張訂單上本地仍 pending 的付款全部失效（發起新付款與顧客取消訂單共用）：向閘道取消，成功就把本地轉 expired
   * （閘道端本來就已失效也算成功）。取消不掉（409：閘道端已經有結果，可能已成功）就查閘道狀態，依結果套用或中止
   * （見 `resolveUncancellable`），避免重複扣款。全部失效回 null，否則回要拒絕的結果。
   * 呼叫端必須已確認訂單屬於當前顧客：這裡不驗身分。沒有 pending 的付款時不需要閘道，也不會呼叫它。
   */
  async function invalidatePendingPayments(orderId: number) {
    const pendings = await selectPendingPayments(db, orderId);
    if (pendings.length > 0 && !gateway) return fail("payment_unavailable");
    for (const pending of pendings) {
      try {
        await gateway!.cancel(pending.gatewayPaymentId);
        await expirePayment(db, pending.id);
      } catch (error) {
        logGatewayError("cancel", error);
        if (!(error instanceof GatewayError && error.status === 409)) return fail("payment_gateway_unavailable");
        // 409：閘道端這筆付款已經有結果（甚至可能已成功，只是 webhook 還沒送到）。查它的狀態，不能貿然放行也不能永遠擋著
        const blocked = await resolveUncancellable(pending, orderId);
        if (blocked) return blocked;
      }
    }
    return null;
  }

  /** 閘道上這筆付款沒有人會用，讓它失效（失敗也無妨，它最晚在付款期限就自己失效）。 */
  async function cancelUnused(gatewayPaymentId: string): Promise<void> {
    try {
      await gateway!.cancel(gatewayPaymentId);
    } catch (error) {
      logGatewayError("cancel", error);
    }
  }

  /**
   * 補查一筆本地仍是 pending 的付款（Cron 與管理員觸發共用；不依賴顧客返回頁面）：向閘道查證，
   * 終局結果一律交給 `applyEvent`（與 webhook、導回查詢同一條套用路徑與事件 ID 去重），這裡不另寫第二條。
   * 查不到、金額或商家參照不符、結果無法套用（成功或失敗卻沒有事件 ID，或本地還在等待時閘道已退款）都不偽造成功，
   * 只記成待辦（`payment_reconcile_issues`）並記一行 log；確認了結果（含閘道說仍在等待）就把開著的待辦記為已解決。
   * `source` 是觸發者（`cron` 或管理員 email），記在待辦上供追溯。呼叫端必須已確認閘道設定存在。
   */
  async function reconcileOne(payment: PaymentToReconcile, source: string): Promise<ReconcileOutcome> {
    const { id, orderId, gatewayPaymentId } = payment;
    const issue = async (reason: ReconcileIssueReason): Promise<ReconcileOutcome> => {
      await recordReconcileIssue(d1, id, reason, source, clock.now());
      console.error(JSON.stringify({ event: "payment_reconcile_issue", paymentId: id, orderId, reason, source }));
      return { outcome: "issue", reason };
    };
    const confirmed = async (outcome: ReconcileOutcome): Promise<ReconcileOutcome> => {
      await resolveReconcileIssue(db, id, clock.now());
      return outcome;
    };

    let queried;
    try {
      queried = await gateway!.getPayment(gatewayPaymentId);
    } catch (error) {
      logGatewayError("getPayment", error);
      return issue("gateway_unavailable");
    }
    if (!gatewayResultMatches(queried, payment, orderId)) return issue("gateway_mismatch");

    if ((queried.status === "succeeded" || queried.status === "failed") && queried.eventId) {
      const applied = await applyEvent({ eventId: queried.eventId, gatewayPaymentId, outcome: queried.status });
      if (!applied.ok) return issue("result_unclear");
      return confirmed({ outcome: "settled", ...applied.data });
    }
    if (queried.status === "expired") {
      await expirePayment(db, id);
      return confirmed({ outcome: "expired" });
    }
    if (queried.status === "pending") return confirmed({ outcome: "waiting" });
    return issue("result_unclear");
  }

  return {
    invalidatePendingPayments,

    /**
     * 管理員補查一筆付款（`paymentId` 是本站付款編號）：只有本地仍是 pending 的付款需要補查，已有結果回 `payment_not_pending`。
     * 呼叫端（管理 RPC）已驗過 Access 身分，`actor` 是管理員 email。
     */
    async reconcilePayment(paymentId: number, actor: string) {
      if (!gateway) return fail("payment_unavailable");
      const payment = await selectPendingPaymentById(db, paymentId);
      if (!payment) return (await paymentExists(db, paymentId)) ? fail("payment_not_pending") : fail("payment_not_found");
      return ok(await reconcileOne(payment, actor));
    },

    /**
     * Cron 入口：補查建立超過寬限時間、本地仍是 pending 的付款（一次有名額上限，見 `selectDuePayments`），冪等。
     * 付款設定不全時不查（log 一行），回傳這次補查的筆數與各結果的筆數。
     */
    async reconcileDuePayments() {
      const tally = { checked: 0, settled: 0, expired: 0, waiting: 0, issues: 0 };
      if (!gateway) {
        console.error(JSON.stringify({ event: "payment_reconcile_skipped", reason: "payment_unavailable" }));
        return tally;
      }
      for (const payment of await selectDuePayments(db, clock.now())) {
        const result = await reconcileOne(payment, "cron");
        tally.checked += 1;
        if (result.outcome === "issue") tally.issues += 1;
        else tally[result.outcome === "settled" ? "settled" : result.outcome] += 1;
      }
      console.log(JSON.stringify({ event: "payments_reconciled", ...tally }));
      return tally;
    },

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
     * 2. 讓同一訂單上本地仍 pending 的付款失效（見 `invalidatePendingPayments`，與顧客取消訂單共用）。
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

      const blocked = await invalidatePendingPayments(orderId);
      if (blocked) return blocked;

      let created;
      try {
        created = await gateway.createPayment({
          merchantReference: String(orderId),
          amountTwd: order.totalTwd,
          returnUrl: `${webOrigin}/orders/${orderId}/payment-return`,
          webhookUrl: `${webOrigin}/api/payments/webhook`,
          expiresAt: paymentExpiresAt(clock.now(), order.paymentDeadline),
        });
      } catch (error) {
        logGatewayError("createPayment", error);
        return fail("payment_gateway_unavailable");
      }

      // 閘道不能把失效時間訂在付款期限或之後（ADR 0001 第一道防線）：這樣的回應不可信，那筆付款不用，讓它失效
      if (created.expiresAt >= order.paymentDeadline) {
        console.error(JSON.stringify({ event: "payment_gateway_invalid_expiry", orderId, gatewayPaymentId: created.paymentId }));
        await cancelUnused(created.paymentId);
        return fail("payment_gateway_unavailable");
      }

      const paymentId = await insertPaymentIfPayable(
        d1,
        { customerId, orderId, gatewayPaymentId: created.paymentId, expiresAt: created.expiresAt },
        clock.now(),
      );
      if (paymentId === null) {
        await cancelUnused(created.paymentId);
        const current = await selectOrderForPayment(db, customerId, orderId);
        const reason = current
          ? diagnoseStart(
              current,
              { hasSucceeded: await hasPaymentWithStatus(db, orderId, "succeeded"), hasPending: await hasPaymentWithStatus(db, orderId, "pending") },
              // 寫入用的是高水位的有效時間，診斷也要用它（系統時鐘可能倒退），才說得出是期限已到還是進入了期限前 2 分鐘
              Math.max(clock.now(), await selectHighWaterMark(db)),
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
