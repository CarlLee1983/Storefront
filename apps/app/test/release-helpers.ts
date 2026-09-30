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

/** 注入時間後直接呼叫 App Worker 的 scheduled 處理程式，與 Cloudflare 每分鐘觸發的路徑相同。 */
export async function runCron(at: number): Promise<void> {
  setNow(at);
  const worker = new AppEntrypoint(createExecutionContext(), env);
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
