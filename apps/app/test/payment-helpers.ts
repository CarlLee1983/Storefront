import { exports } from "cloudflare:workers";
import { mintAccessJwt } from "./access";
import { checkoutInput, createStockedProduct, type LineInput } from "./checkout-helpers";

const app = exports.default;

/** 以一筆明細結帳，成立一張待付款訂單，回傳訂單編號。 */
export async function placeOrder(cookie: string, lines: LineInput[]): Promise<number> {
  const result = await app.checkout(cookie, checkoutInput(lines));
  if (!result.ok) throw new Error(`結帳失敗：${result.reason}`);
  return result.data.orderId;
}

/** 建立一件商品（單價 320、在庫 onHand）並替顧客結帳 quantity 件，回傳商品與訂單編號。 */
export async function placeMugOrder(cookie: string, { onHand = 10, quantity = 2 } = {}) {
  const productId = await createStockedProduct("馬克杯", 320, onHand);
  const orderId = await placeOrder(cookie, [{ productId, quantity, seenUnitPriceTwd: 320 }]);
  return { productId, orderId, totalTwd: 320 * quantity };
}

/** 訂單目前的狀態與付款嘗試（走 RPC 讀取）。 */
export async function orderOf(cookie: string, orderId: number) {
  const found = await app.getMyOrder(cookie, { orderId });
  if (!found.ok) throw new Error(`讀取訂單失敗：${found.reason}`);
  return found.data;
}

/** 商品目前的在庫數與可售數量（管理 RPC 讀取）。 */
export async function stockOf(productId: number): Promise<{ onHand: number; available: number }> {
  const found = await app.getProductForAdmin(await mintAccessJwt(), { id: productId });
  if (!found.ok) throw new Error("讀取商品失敗");
  return { onHand: found.data.onHand, available: found.data.available };
}
