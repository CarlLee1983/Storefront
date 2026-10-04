import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { Clock } from "../shared/clock";
import { parseInput } from "../shared/input";
import { fail, ok, type Unauthorized } from "../shared/result";
import { orderIdInput } from "../orders/input";
import { orders, type OrderStatus } from "../orders/schema";
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
  selectPendingPayments,
} from "./queries";
import { deliverNoticeSafely } from "../contact/notify";
import type { InvoiceService } from "../invoices/service";
import { paymentExpiresAt } from "../orders/payment-deadline";
import { isExplicitRefundFailure, refundReasonFor } from "./refund";
import {
  actionFor,
  claimRefund,
  hasOtherUncertainRefund,
  recordRefundAttempt,
  registerPaymentRefund,
  selectRefundToRun,
  type RefundToRun,
} from "./refunds";
import { markReconciled, paymentExists, RECONCILE_BUDGET_MS, recordReconcileIssue, resolveReconcileIssue, selectDuePayments, selectPendingPaymentById, type PaymentToReconcile } from "./reconcile";
import type { PaymentEvent, ReconcileIssueReason, RefundAttemptAction, RefundStatus } from "./shared";

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
  invoices: Pick<InvoiceService, "issueForPayment" | "allowForRefund">,
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

  /** 閘道回的付款 ID、金額與商家參照必須與本站記錄一致；不一致記一行 log。 */
  function gatewayResultMatches(queried: GatewayPayment, payment: { gatewayPaymentId: string; amountTwd: number }, orderId: number): boolean {
    if (queried.paymentId === payment.gatewayPaymentId && queried.amountTwd === payment.amountTwd && queried.merchantReference === String(orderId)) return true;
    console.error(JSON.stringify({ event: "payment_gateway_mismatch", orderId, gatewayPaymentId: queried.paymentId }));
    return false;
  }

  /**
   * 執行（或重試）一筆退款，首次退款與管理員重試共用；`actor` 是 `system` 或管理員 email，記在每次嘗試上。
   * 閘道退款以退款紀錄的 `gateway_refund_id` 為冪等鍵，所以重送不會多退；流程（ADR 0007）：
   * 1. 搶執行權（`claimRefund`）：同張訂單一次最多一筆在送出，且同單有「結果不明」的退款時其他筆不能開始（`refund_blocked`）。
   * 2. 結果不明（或程序中斷而租約過期）的退款先向閘道查證，不盲目重送：閘道說已成功就記成功；說失敗或從未收過，才確定沒退成，接著送出；查證本身失敗仍是不明。
   * 3. 送出：成功記成功；閘道明確拒絕記失敗（保留額度、列待辦、後筆可前進）；連不上、逾時、回應異常記不明。
   * 每次嘗試與狀態在同一個 batch 寫入，成功時退款通知信也同一個 batch（outbox）。
   * 沒有閘道設定回 `payment_unavailable`，什麼都不改。
   */
  async function runRefund(refundId: number, actor: string) {
    if (!gateway) return fail("payment_unavailable");
    const refund = await selectRefundToRun(db, refundId);
    if (!refund) return fail("refund_not_found");
    const startedAt = clock.now();
    const action = actionFor(refund, startedAt);
    if (action === "done") {
      // 已成功的退款重試：補上先前沒折讓成的（原票當時未開立、折讓失敗），已折讓的不會再送
      await invoices.allowForRefund(refundId);
      return ok({ status: "succeeded" as RefundStatus });
    }
    if (action === "busy") return fail("refund_in_progress");
    if (!(await claimRefund(d1, refund, startedAt))) {
      return fail((await hasOtherUncertainRefund(db, refund)) ? "refund_blocked" : "refund_in_progress");
    }

    const record = (step: { action: RefundAttemptAction; outcome: "succeeded" | "failed" | "unknown" | "not_found"; code?: string; status: "succeeded" | "failed" | "unknown" | null }) =>
      recordRefundAttempt(d1, { refundId, claimedAt: startedAt, actor, action: step.action, outcome: step.outcome, code: step.code ?? null, status: step.status }, clock.now());
    const finish = async (status: "succeeded" | "failed" | "unknown") => {
      if (status === "succeeded") {
        await deliverNoticeSafely(db, `refund:${refundId}`, clock.now());
        // 成功退款折讓：原票已開立才送出，否則保留義務等原票開立（見 `invoices/service.ts`）；折讓出錯不影響退款
        await invoices.allowForRefund(refundId);
      }
      console.log(JSON.stringify({ event: "refund_attempted", refundId, orderId: refund.orderId, actor, status }));
      return ok({ status: (await selectRefundToRun(db, refundId))?.status ?? status });
    };

    if (action === "verify") {
      let found;
      try {
        found = await gateway.getRefund(refund.gatewayPaymentId, refund.gatewayRefundId);
      } catch (error) {
        logGatewayError("getRefund", error);
        await record({ action: "verify", outcome: "unknown", code: error instanceof GatewayError ? error.code : undefined, status: "unknown" });
        return finish("unknown");
      }
      if (found && !refundMatches(found, refund)) {
        await record({ action: "verify", outcome: "unknown", code: "gateway_mismatch", status: "unknown" });
        return finish("unknown");
      }
      if (found?.status === "succeeded") {
        await record({ action: "verify", outcome: "succeeded", status: "succeeded" });
        return finish("succeeded");
      }
      // 閘道說失敗，或從未收過這個退款 ID：確定款項沒有退回，才接著送出
      await record({ action: "verify", outcome: found ? "failed" : "not_found", status: null });
    }

    try {
      const sent = await gateway.refund({ gatewayPaymentId: refund.gatewayPaymentId, refundId: refund.gatewayRefundId, amountTwd: refund.amountTwd });
      if (sent.status !== "succeeded" || !refundMatches(sent, refund)) {
        await record({ action: "send", outcome: "unknown", code: "gateway_mismatch", status: "unknown" });
        return finish("unknown");
      }
      await record({ action: "send", outcome: "succeeded", status: "succeeded" });
      return finish("succeeded");
    } catch (error) {
      logGatewayError("refund", error);
      const code = error instanceof GatewayError ? error.code : undefined;
      const explicit = error instanceof GatewayError && isExplicitRefundFailure(error);
      await record({ action: "send", outcome: explicit ? "failed" : "unknown", code, status: explicit ? "failed" : "unknown" });
      return finish(explicit ? "failed" : "unknown");
    }
  }

  /** 閘道回的退款 ID、付款與金額必須與本地紀錄一致，否則不信任這個回應（結果當作不明）。 */
  function refundMatches(gatewayRefund: { refundId: string; paymentId: string; amountTwd: number }, refund: RefundToRun): boolean {
    if (gatewayRefund.refundId === refund.gatewayRefundId && gatewayRefund.paymentId === refund.gatewayPaymentId && gatewayRefund.amountTwd === refund.amountTwd) return true;
    console.error(JSON.stringify({ event: "refund_gateway_mismatch", refundId: refund.id, orderId: refund.orderId }));
    return false;
  }

  /**
   * 付款成功、但訂單沒有因它轉為已付款時的退款（原因見 `refundReasonFor`）：登記一筆整筆退款（`registerPaymentRefund`，
   * 一筆付款最多一筆，事件重送與補登記都不會重複），登記了才立刻以 `system` 執行；已經登記過的退款不在這裡重送
   * （失敗與不明由管理員在退款待辦處理）。
   * 由搶到事件的那次呼叫進來；事件重送時也會進來，補上「付款結果已套用、但程序在登記退款之前中斷」缺的登記。
   */
  async function refundUnsettledPayment(payment: { id: number; orderId: number; gatewayPaymentId: string }, orderStatus: OrderStatus) {
    const { id, orderId, gatewayPaymentId } = payment;
    const [paidOrder] = await db.select({ paidBy: orders.paidByPaymentId }).from(orders).where(eq(orders.id, orderId));
    const reason = refundReasonFor(orderStatus, paidOrder?.paidBy != null);
    if (!reason) {
      console.error(JSON.stringify({ event: "payment_refund_skipped", orderId, gatewayPaymentId, orderStatus }));
      return;
    }
    const refundId = await registerPaymentRefund(d1, id, reason, clock.now());
    if (refundId === null) return;
    const registered = await selectRefundToRun(db, refundId);
    if (registered?.status !== "pending") return;
    const outcome = await runRefund(refundId, "system");
    if (!outcome.ok) console.error(JSON.stringify({ event: "payment_refund_not_started", orderId, gatewayPaymentId, refundId, reason: outcome.reason }));
  }

  /**
   * 套用付款結果（webhook 與導回查詢共用）：以事件 ID 冪等，重複的事件只套用一次、回同一結果。
   * 付款結果通知的信件與付款結果同一個 batch 寫入（outbox，見 `contact/notices.ts`）；batch 之後才投遞，投遞出錯只記 log，
   * 付款不受影響，事件重送時補上缺的投遞。
   * 付款成功時另在同一 batch 登記模擬發票的開立義務，batch 之後才向發票服務開立（見 `invoices/service.ts`）；事件重送時補開尚未開立的、補上缺的發票通知投遞。
   * 付款成功時的分流在 `applyPaymentEvent`（待付款轉已付款、已逾期重新保留）；沒能讓訂單轉為已付款的成功付款
   * （重新保留不到、已取消、第二筆成功）登記退款並執行（見 `refundUnsettledPayment`）。回傳的是退款之後的付款與訂單狀態。
   */
  async function applyEvent(event: PaymentEvent) {
    const payment = await selectPaymentByGatewayId(db, event.gatewayPaymentId);
    if (!payment) return fail("payment_not_found");

    const { orderSettled, orderStatus } = await applyPaymentEvent(d1, { ...event, orderId: payment.orderId }, clock.now());
    if (event.outcome === "succeeded" && !orderSettled) {
      await refundUnsettledPayment({ id: payment.id, orderId: payment.orderId, gatewayPaymentId: event.gatewayPaymentId }, orderStatus);
    }
    await deliverNoticeSafely(db, `payment:${payment.id}`, clock.now());
    // 成功收款開立模擬發票：在 batch 與退款之後、交易之外呼叫發票服務；失敗與逾時只留紀錄待補辦，不影響付款結果
    if (event.outcome === "succeeded") await invoices.issueForPayment(payment.id);
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
      await expirePayment(db, pending.id, clock.now());
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
        await expirePayment(db, pending.id, clock.now());
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
   * 查不到、付款 ID／金額／商家參照不符、結果無法套用（成功或失敗卻沒有事件 ID）都不偽造成功，
   * 只記成待辦（`payment_reconcile_issues`）並記一行 log；付款離開 pending 時待辦由套用的路徑一併解決，閘道說仍在等待則在這裡解決。
   * `source` 是觸發者（`cron` 或管理員 email），記在待辦上供追溯。呼叫端必須已確認閘道設定存在。
   */
  async function reconcileOne(payment: PaymentToReconcile, source: string): Promise<ReconcileOutcome> {
    const { id, orderId, gatewayPaymentId } = payment;
    const issue = async (reason: ReconcileIssueReason): Promise<ReconcileOutcome> => {
      await recordReconcileIssue(d1, id, reason, source, clock.now());
      console.error(JSON.stringify({ event: "payment_reconcile_issue", paymentId: id, orderId, reason, source }));
      return { outcome: "issue", reason };
    };
    // 查之前先記下補查時間：閘道卡住、出錯或結果不明的付款也要讓位給 Cron 的其他付款
    await markReconciled(db, id, clock.now());

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
      return { outcome: "settled", ...applied.data };
    }
    if (queried.status === "expired") {
      await expirePayment(db, id, clock.now());
      return { outcome: "expired" };
    }
    if (queried.status === "pending") {
      // 閘道說還在等待：之前的問題已經不存在（付款離開 pending 時，套用的路徑會自己解決待辦）
      await resolveReconcileIssue(db, id, clock.now());
      return { outcome: "waiting" };
    }
    return issue("result_unclear");
  }

  return {
    invalidatePendingPayments,

    /**
     * 管理員重試一筆退款（`refundId` 是本站退款編號），操作者記在嘗試紀錄上；呼叫端（管理 RPC）已驗過 Access 身分。
     * 明確失敗的直接重送；結果不明的先向閘道查證再決定（見 `runRefund`）；已成功的冪等回成功。
     */
    retryRefund(refundId: number, actor: string) {
      return runRefund(refundId, actor);
    },

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
      const startedAt = Date.now();
      for (const payment of await selectDuePayments(db, clock.now())) {
        // 閘道慢時不再開始新的一筆：同一次 Cron 後面的訂單逾期與圖片清理不能被補查拖住（沒查到的下次輪替）
        if (Date.now() - startedAt >= RECONCILE_BUDGET_MS) {
          console.error(JSON.stringify({ event: "payment_reconcile_budget_exhausted", checked: tally.checked }));
          break;
        }
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
     * 其他還沒有結果的狀態（pending，或成功卻沒有事件 ID）不套用，回目前狀態。
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
      if (!gatewayResultMatches(queried, { ...payment, gatewayPaymentId }, orderId)) return fail("payment_mismatch");
      if ((queried.status === "succeeded" || queried.status === "failed") && queried.eventId) {
        return applyEvent({ eventId: queried.eventId, gatewayPaymentId, outcome: queried.status });
      }
      // 閘道端已失效（顧客沒付、或被取消）：本地不再停在 pending
      if (queried.status === "expired") await expirePayment(db, payment.id, clock.now());
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
