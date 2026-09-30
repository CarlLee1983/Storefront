import { env, exports } from "cloudflare:workers";
import { createExecutionContext, createScheduledController } from "cloudflare:test";
import { checkoutInput, createStockedProduct } from "./checkout-helpers";
import { mintAccessJwt } from "./access";
import { setNow } from "./clock";
import { AppEntrypoint } from "../src/entrypoint";
import type { OrderStatus } from "../src/orders/schema";

export const app = exports.default;
export const PAYMENT_WINDOW_MS = 15 * 60 * 1000;
export const PRICE = 100;

/** 在注入的時間 `at` 以指定顧客結帳一張訂單，回傳訂單編號與付款期限。 */
export async function placeOrderAt(cookie: string, productId: number, quantity: number, at: number) {
  setNow(at);
  const result = await app.checkout(cookie, checkoutInput([{ productId, quantity, seenUnitPriceTwd: PRICE }]));
  if (!result.ok) throw new Error("結帳失敗");
  return result.data;
}

export async function stocked(onHand: number): Promise<number> {
  return createStockedProduct("馬克杯", PRICE, onHand);
}

/**
 * 讓 Cron 每個 D1 batch 完成之後先暫停、執行 `hook` 才繼續，用來確定性地重現「Cron 讀到資料之後、
 * 寫入之前，別的請求插進來」的時序；`Promise.all` 併發不保證交錯，單靠它抓不到先讀後寫的實作。
 */
function envPausingAfterBatch(hook: () => Promise<void>): Env {
  const db = new Proxy(env.DB, {
    get(target, prop) {
      if (prop === "batch") {
        return async (...args: Parameters<D1Database["batch"]>) => {
          const results = await target.batch(...args);
          await hook();
          return results;
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return new Proxy(env, { get: (target, prop) => (prop === "DB" ? db : Reflect.get(target, prop, target)) });
}

/** 注入時間後直接呼叫 App Worker 的 scheduled 處理程式，與 Cloudflare 每分鐘觸發的路徑相同。 */
export async function runCron(at: number, afterBatch?: () => Promise<void>): Promise<void> {
  setNow(at);
  const worker = new AppEntrypoint(createExecutionContext(), afterBatch ? envPausingAfterBatch(afterBatch) : env);
  await worker.scheduled(createScheduledController({ cron: "* * * * *", scheduledTime: new Date(at) }));
}

export async function statusOf(cookie: string, orderId: number): Promise<OrderStatus> {
  const found = await app.getMyOrder(cookie, { orderId });
  if (!found.ok) throw new Error("讀取訂單失敗");
  return found.data.status;
}

export async function stockOf(productId: number): Promise<{ onHand: number; available: number }> {
  const found = await app.getProductForAdmin(await mintAccessJwt(), { id: productId });
  if (!found.ok) throw new Error("讀取商品失敗");
  return { onHand: found.data.onHand, available: found.data.available };
}
