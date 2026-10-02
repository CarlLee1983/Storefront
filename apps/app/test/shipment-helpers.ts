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

/** 交運訂單裡每筆明細各 `quantity` 件，成為新的一批，回傳批次編號。 */
export async function shipBatch(orderId: number, quantity = 1): Promise<number> {
  const order = await adminOrder(orderId);
  const items = order.lines.map((line) => ({ orderLineId: line.id, quantity }));
  const shipped = await app.shipOrder(await mintAccessJwt(), { orderId, dispatchKey: newKey(), items });
  if (!shipped.ok) throw new Error(`交運失敗：${shipped.reason}`);
  return shipped.data.shipmentId;
}

/** 一個批次目前的樣子（走管理端讀取）。 */
export async function adminShipment(orderId: number, shipmentId: number) {
  const shipment = (await adminOrder(orderId)).shipments.find((candidate) => candidate.id === shipmentId);
  if (!shipment) throw new Error(`找不到批次 ${shipmentId}`);
  return shipment;
}

/** 管理員記錄一筆物流回報（模擬物流回報）。 */
export async function reportShipmentEvent(shipmentId: number, eventKey: string, kind: "delivered" | "delivery_failed" | "redelivery", occurredAt: number) {
  return app.recordShipmentEvent(await mintAccessJwt(), { shipmentId, eventKey, kind, occurredAt });
}
