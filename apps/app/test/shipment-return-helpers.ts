import { exports } from "cloudflare:workers";
import { mintAccessJwt } from "./access";
import { newKey } from "./checkout-helpers";

const app = exports.default;

type DeclareItem = { orderLineId: number; quantity: number; foundLostQuantity?: number };

/** 管理員登記某批被物流退回；`returnKey` 不給就用新的。回傳 RPC 結果原樣。 */
export async function declareReturn(shipmentId: number, items: DeclareItem[], extra: Record<string, unknown> = {}) {
  return app.declareShipmentReturn(await mintAccessJwt(), { shipmentId, returnKey: newKey(), items, ...extra });
}

/** 登記物流退回並要求成功，回傳案件編號。 */
export async function declareReturnOk(shipmentId: number, items: DeclareItem[]): Promise<number> {
  const result = await declareReturn(shipmentId, items);
  if (!result.ok) throw new Error(`登記物流退回失敗：${result.reason}`);
  return result.data.returnId;
}

export async function receiveShipmentReturn(returnId: number, items: { orderLineId: number; receivedQuantity: number; receivedFoundLostQuantity?: number }[], note = "") {
  return app.recordShipmentReturnReceipt(await mintAccessJwt(), { returnId, items, note });
}

export async function inspectShipmentReturn(returnId: number, items: { orderLineId: number; sellableQuantity: number; damagedQuantity: number }[], note = "") {
  return app.recordShipmentReturnInspection(await mintAccessJwt(), { returnId, items, note });
}

/** 登記、收回（全數）、檢查（全良品）一路走完，回傳檢查結果資料。 */
export async function returnAllSellable(shipmentId: number, items: { orderLineId: number; quantity: number }[]) {
  const returnId = await declareReturnOk(shipmentId, items);
  const received = await receiveShipmentReturn(returnId, items.map((item) => ({ orderLineId: item.orderLineId, receivedQuantity: item.quantity })));
  if (!received.ok) throw new Error(`記錄收回失敗：${received.reason}`);
  const inspected = await inspectShipmentReturn(returnId, items.map((item) => ({ orderLineId: item.orderLineId, sellableQuantity: item.quantity, damagedQuantity: 0 })));
  if (!inspected.ok) throw new Error(`記錄檢查失敗：${inspected.reason}`);
  return inspected.data;
}
