import { exports } from "cloudflare:workers";
import { mintAccessJwt } from "./access";
import { newKey } from "./checkout-helpers";

const app = exports.default;

/** 大型配送明細的議定時段（2026-10-10 09:00–12:00 台灣時間）。 */
export const APPOINTMENT = { start: Date.UTC(2026, 9, 10, 1, 0), end: Date.UTC(2026, 9, 10, 4, 0) };

export async function adminOrder(orderId: number) {
  const found = await app.getOrderForAdmin(await mintAccessJwt(), { orderId });
  if (!found.ok) throw new Error(`讀取訂單失敗：${found.reason}`);
  return found.data;
}

/** 把訂單目前所有未交運的數量一次交運（有大型配送明細時帶議定時段）。`extra` 可覆寫任何輸入欄位；自己指定 `items` 時不自動帶時段。 */
export async function shipRemaining(orderId: number, extra: Record<string, unknown> = {}) {
  const order = await adminOrder(orderId);
  const items = order.lines.filter((line) => line.quantity > line.shippedQuantity).map((line) => ({ orderLineId: line.id, quantity: line.quantity - line.shippedQuantity }));
  const hasLarge = order.lines.some((line) => line.deliveryType === "large" && line.quantity > line.shippedQuantity);
  return app.shipOrder(await mintAccessJwt(), { orderId, dispatchKey: newKey(), items, ...(hasLarge && !extra.items ? { appointment: APPOINTMENT } : {}), ...extra });
}
