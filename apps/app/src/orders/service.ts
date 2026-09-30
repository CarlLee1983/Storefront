import { drizzle } from "drizzle-orm/d1";
import type { Clock } from "../shared/clock";
import { parseInput } from "../shared/input";
import { fail, ok, type Unauthorized } from "../shared/result";
import { diagnoseLines } from "./diagnosis";
import { checkoutInput, orderIdInput } from "./input";
import { placeOrderIfAvailable, selectOrders, selectProductStates, selectRequestHash } from "./queries";
import { requestHash } from "./request-hash";

/** 回傳顧客編號；沒有有效 session 回 null。 */
export type AuthenticateCustomer = (cookie: string) => Promise<string | null>;

/** 診斷不出原因時的重試次數上限。 */
const MAX_ATTEMPTS = 3;

export function createOrderService(d1: D1Database, clock: Clock, authenticate: AuthenticateCustomer) {
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
          return ok({
            orderId: order.id,
            status: order.status,
            totalTwd: order.totalTwd,
            paymentDeadline: order.paymentDeadline,
          });
        }
        const states = await selectProductStates(db, request.lines.map((line) => line.productId));
        const issues = diagnoseLines(request.lines, states);
        if (issues.length > 0) return { ok: false as const, reason: "checkout_rejected" as const, issues };
      }
      // 狀態一直在變動而診斷不出原因：不是顧客的錯，重送同一個冪等鍵是安全的
      return fail("checkout_unavailable");
    },

    async listMyOrders(cookie: unknown) {
      const customerId = await customerOf(cookie);
      if (!customerId) return unauthorized;
      return ok(await selectOrders(db, customerId));
    },

    async getMyOrder(cookie: unknown, input: unknown) {
      const customerId = await customerOf(cookie);
      if (!customerId) return unauthorized;
      const parsed = parseInput(orderIdInput, input);
      if (!parsed.ok) return parsed;

      const [order] = await selectOrders(db, customerId, { orderId: parsed.data.orderId });
      return order ? ok(order) : fail("order_not_found");
    },
  };
}
