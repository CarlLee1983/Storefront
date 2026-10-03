import { exports } from "cloudflare:workers";
import { mintAccessJwt } from "./access";
import { newKey } from "./checkout-helpers";
import { paidMixedOrder, type PaidMixedOrder } from "./cancellation-helpers";
import { adminOrder, APPOINTMENT } from "./shipment-helpers";

const app = exports.default;

/** 已付款並全部交運（馬克杯 3、餐桌 1）的混合訂單，供退貨測試使用。 */
export async function shippedMixedOrder(name = "alice"): Promise<PaidMixedOrder> {
  const order = await paidMixedOrder(name);
  const shipped = await app.shipOrder(await mintAccessJwt(), {
    orderId: order.orderId,
    dispatchKey: newKey(),
    items: [{ orderLineId: order.mugLine.id, quantity: 3 }, { orderLineId: order.tableLine.id, quantity: 1 }],
    appointment: APPOINTMENT,
  });
  if (!shipped.ok) throw new Error(`交運失敗：${shipped.reason}`);
  return order;
}

/** 變體目前的庫存四個數字（走管理端讀取）。 */
export async function stockDetail(variantId: number): Promise<{ onHand: number; unavailable: number; reserved: number; available: number }> {
  const listed = await app.listProductsForAdmin(await mintAccessJwt());
  const found = listed.ok ? listed.data.flatMap((product) => product.variants).find((variant) => variant.id === variantId) : undefined;
  if (!found) throw new Error("讀取商品失敗");
  return { onHand: found.onHand, unavailable: found.unavailable, reserved: found.reserved, available: found.available };
}

/** 顧客申請退貨；`key` 不給就用新的冪等鍵。回傳 RPC 結果原樣。 */
export function requestReturn(cookie: string, orderId: number, items: { orderLineId: number; quantity: number }[], extra: Record<string, unknown> = {}) {
  return app.requestReturn(cookie, { orderId, requestKey: newKey(), items, ...extra });
}

/** 顧客申請退貨並要求成功，回傳申請編號。 */
export async function requestReturnOk(cookie: string, orderId: number, items: { orderLineId: number; quantity: number }[]): Promise<number> {
  const result = await requestReturn(cookie, orderId, items);
  if (!result.ok) throw new Error(`申請退貨失敗：${result.reason}`);
  return result.data.requestId;
}

export async function decideReturn(requestId: number, decision: "approve" | "reject", note = "") {
  return app.decideReturn(await mintAccessJwt(), { requestId, decision, note });
}

export async function approveReturn(requestId: number) {
  const result = await decideReturn(requestId, "approve");
  if (!result.ok) throw new Error(`核准退貨失敗：${result.reason}`);
}

export async function receiveReturn(requestId: number, items: { orderLineId: number; receivedQuantity: number }[], note = "") {
  return app.recordReturnReceipt(await mintAccessJwt(), { requestId, items, note });
}

export async function inspectReturn(requestId: number, items: { orderLineId: number; sellableQuantity: number; damagedQuantity: number }[], note = "") {
  return app.recordReturnInspection(await mintAccessJwt(), { requestId, items, note });
}

/** 申請、核准、收回（全數）、檢查（全良品）一路走完，回傳檢查結果資料。 */
export async function returnAllSellable(cookie: string, orderId: number, items: { orderLineId: number; quantity: number }[]) {
  const requestId = await requestReturnOk(cookie, orderId, items);
  await approveReturn(requestId);
  const received = await receiveReturn(requestId, items.map((item) => ({ orderLineId: item.orderLineId, receivedQuantity: item.quantity })));
  if (!received.ok) throw new Error(`記錄收回失敗：${received.reason}`);
  const inspected = await inspectReturn(requestId, items.map((item) => ({ orderLineId: item.orderLineId, sellableQuantity: item.quantity, damagedQuantity: 0 })));
  if (!inspected.ok) throw new Error(`記錄檢查失敗：${inspected.reason}`);
  return inspected.data;
}

export const refundsOf = async (orderId: number) => (await adminOrder(orderId)).refunds;
