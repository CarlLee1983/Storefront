import { drizzle } from "drizzle-orm/d1";
import type { Clock } from "../shared/clock";
import { parseInput } from "../shared/input";
import { fail, ok, type Unauthorized } from "../shared/result";
import { deliverNoticeSafely } from "../contact/notify";
import { selectVerifiedEmail } from "../contact/queries";
import { selectPaymentSummaries } from "../payments/queries";
import { selectRefundSummaries } from "../payments/refunds";
import type { InvalidatePaymentsRefusal } from "../payments/shared";
import { selectShippingFees } from "../shipping/queries";
import { diagnoseLines } from "./diagnosis";
import { checkoutInput, orderIdInput } from "./input";
import { cancelPendingOrder, markOverdueOrdersExpired, placeOrderIfAvailable, selectOrderStatus, selectOrders, selectVariantStates, selectRequestHash } from "./queries";
import { requestHash } from "./request-hash";
import { CANCELLED } from "./schema";
import { allowedSources } from "./transitions";

/** 回傳顧客編號；沒有有效 session 回 null。 */
export type AuthenticateCustomer = (cookie: string) => Promise<string | null>;

/**
 * 讓訂單上進行中的付款失效（由付款模組提供，見 `payments/service.ts` 的 `invalidatePendingPayments`）：
 * 全部失效回 null，否則回要拒絕的原因。以注入的函式接入，訂單模組不依賴付款 service 與閘道。
 */
export type InvalidatePayments = (orderId: number) => Promise<{ ok: false; reason: InvalidatePaymentsRefusal } | null>;

/** 診斷不出原因時的重試次數上限。 */
const MAX_ATTEMPTS = 3;

export function createOrderService(d1: D1Database, clock: Clock, authenticate: AuthenticateCustomer, invalidatePayments: InvalidatePayments) {
  const db = drizzle(d1);
  const unauthorized: Unauthorized = { ok: false, reason: "unauthorized" };

  /** cookie 換顧客編號；不是字串或沒有有效 session 回 null。 */
  async function customerOf(cookie: unknown): Promise<string | null> {
    return typeof cookie === "string" ? authenticate(cookie) : null;
  }

  return {
    async checkout(cookie: unknown, input: unknown) {
      const customerId = await customerOf(cookie);
      if (!customerId) return unauthorized;
      const parsed = parseInput(checkoutInput, input);
      if (!parsed.ok) return parsed;
      // 顧客首次結帳前須有已驗證的聯絡 email（交易通知的收件地址）；已驗證過就一直有，換址的新地址驗證前不影響
      if (!(await selectVerifiedEmail(db, customerId))) return fail("contact_email_unverified");

      const request = { customerId, ...parsed.data, requestHash: await requestHash(parsed.data) };
      // 診斷與寫入之間狀態可能變動（例如剛好有人補貨）：診斷找不到問題就再試一次，有上限
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        const { created } = await placeOrderIfAvailable(d1, request, clock.now());
        // 成立的、或冪等重送而已存在的訂單，都以（顧客, 冪等鍵）取回；這組鍵有唯一約束
        const [order] = await selectOrders(db, customerId, { idempotencyKey: request.idempotencyKey });
        if (order) {
          // 訂單成立時就寫入內容指紋、之後不變；讀回時比對，同一個鍵帶不同內容是誤用，不回舊訂單
          if ((await selectRequestHash(db, customerId, request.idempotencyKey)) !== request.requestHash) {
            return fail("idempotency_key_reused");
          }
          if (created) console.log(JSON.stringify({ event: "order_placed", orderId: order.id, lineCount: order.lines.length }));
          // 冪等重送也會呼叫：信件本體在下單 batch 內已寫好，這裡只投遞：已有投遞就不重複，上一次投遞階段出錯缺的首次投遞會在這裡補上
          await deliverNoticeSafely(db, `order_placed:${order.id}`, clock.now());
          return ok({
            orderId: order.id,
            status: order.status,
            totalTwd: order.totalTwd,
            paymentDeadline: order.paymentDeadline,
          });
        }
        const states = await selectVariantStates(db, request.lines.map((line) => line.variantId));
        const issues = diagnoseLines(request.lines, states);
        if (issues.length > 0) return { ok: false as const, reason: "checkout_rejected" as const, issues };
        // 明細都沒問題卻沒成立：可能是運費在顧客確認之後被調整；回報現行運費，由顧客重新確認總額
        const currentShippingTwd = (await selectShippingFees(db, request.lines.map((line) => line.variantId))).totalTwd;
        if (currentShippingTwd !== request.seenShippingTwd) return { ok: false as const, reason: "shipping_fee_changed" as const, currentShippingTwd };
      }
      // 狀態一直在變動而診斷不出原因：不是顧客的錯，重送同一個冪等鍵是安全的
      return fail("checkout_unavailable");
    },

    /** Cron 入口：不需要顧客身分，只看付款期限；冪等，回傳這次轉為已逾期的筆數。 */
    async expireOverdueOrders() {
      const count = await markOverdueOrdersExpired(d1, clock.now());
      console.log(JSON.stringify({ event: "orders_expired", count }));
      return count;
    },

    async listMyOrders(cookie: unknown) {
      const customerId = await customerOf(cookie);
      if (!customerId) return unauthorized;
      const orders = await selectOrders(db, customerId);
      const payments = await selectPaymentSummaries(db, customerId, clock.now());
      const refunds = await selectRefundSummaries(db, customerId);
      // 付款嘗試與退款由 payments 模組提供，在這裡與訂單組合（orders 的查詢不依賴 payments）
      return ok(orders.map((order) => ({ ...order, payments: payments.get(order.id) ?? [], refunds: refunds.get(order.id) ?? [] })));
    },

    async getMyOrder(cookie: unknown, input: unknown) {
      const customerId = await customerOf(cookie);
      if (!customerId) return unauthorized;
      const parsed = parseInput(orderIdInput, input);
      if (!parsed.ok) return parsed;

      const [order] = await selectOrders(db, customerId, { orderId: parsed.data.orderId });
      if (!order) return fail("order_not_found");
      const payments = await selectPaymentSummaries(db, customerId, clock.now(), order.id);
      const refunds = await selectRefundSummaries(db, customerId, order.id);
      return ok({ ...order, payments: payments.get(order.id) ?? [], refunds: refunds.get(order.id) ?? [] });
    },

    /**
     * 取消自己的待付款訂單（已取消是終點）。別人的或不存在的訂單一律 `order_not_found`，不洩漏存在與否；
     * 自己的但不是待付款（已逾期、已取消、已付款、已出貨）回 `order_not_cancellable`。
     *
     * 待付款的訂單先讓進行中的付款全部失效，再執行條件式取消（US 22）：
     * - 閘道取消不掉、查詢後發現付款其實已成功：那筆付款會讓訂單轉為已付款，取消回 `order_not_cancellable`。
     * - 閘道連不上、付款仍在進行中、或付款設定不全：回 `payment_gateway_unavailable`／`payment_in_progress`／`payment_unavailable`，
     *   訂單不取消（不能在付款可能還活著時就取消）。
     * 即便如此，取消之後仍可能有付款成功落在已取消的訂單上（與新付款競態），那由「套用付款結果」退款。
     * 前面對訂單狀態的讀取只用來決定要不要碰閘道，取消本身仍是單句條件式 UPDATE，是否成功由受影響列數判斷。
     */
    async cancelOrder(cookie: unknown, input: unknown) {
      const customerId = await customerOf(cookie);
      if (!customerId) return unauthorized;
      const parsed = parseInput(orderIdInput, input);
      if (!parsed.ok) return parsed;

      const { orderId } = parsed.data;
      const order = await selectOrderStatus(db, customerId, orderId);
      if (!order) return fail("order_not_found");
      if (!allowedSources(CANCELLED).includes(order.status)) return fail("order_not_cancellable");

      const blocked = await invalidatePayments(orderId);
      if (blocked) return fail(blocked.reason === "payment_already_succeeded" ? "order_not_cancellable" : blocked.reason);
      if (await cancelPendingOrder(db, customerId, orderId)) {
        console.log(JSON.stringify({ event: "order_cancelled", orderId }));
        return ok({ orderId, status: CANCELLED });
      }
      // 失效付款的空檔裡訂單被別的動作轉走了（例如剛好逾期）
      return fail("order_not_cancellable");
    },
  };
}
