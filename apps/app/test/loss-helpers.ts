import { exports } from "cloudflare:workers";
import { mintAccessJwt } from "./access";
import { newKey } from "./checkout-helpers";
import { APPOINTMENT } from "./shipment-helpers";

const app = exports.default;

/** 交運指定明細數量成為新的一批（含大型配送時帶議定時段），回傳批次編號。 */
export async function shipItems(orderId: number, items: { orderLineId: number; quantity: number }[], hasLarge = false): Promise<number> {
  const shipped = await app.shipOrder(await mintAccessJwt(), { orderId, dispatchKey: newKey(), items, ...(hasLarge ? { appointment: APPOINTMENT } : {}) });
  if (!shipped.ok) throw new Error(`交運失敗：${shipped.reason}`);
  return shipped.data.shipmentId;
}

/** 管理員確認某批遺失；`lossKey` 不給就用新的。回傳 RPC 結果原樣。 */
export async function confirmLoss(shipmentId: number, items: { orderLineId: number; quantity: number }[], extra: Record<string, unknown> = {}) {
  return app.confirmShipmentLoss(await mintAccessJwt(), { shipmentId, lossKey: newKey(), items, ...extra });
}

/** 確認遺失並要求成功，回傳結果資料。 */
export async function confirmLossOk(shipmentId: number, items: { orderLineId: number; quantity: number }[]) {
  const result = await confirmLoss(shipmentId, items);
  if (!result.ok) throw new Error(`確認遺失失敗：${result.reason}`);
  return result.data;
}
