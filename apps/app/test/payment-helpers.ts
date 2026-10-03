import { exports } from "cloudflare:workers";
import { mintAccessJwt } from "./access";
import { checkoutInput, createStockedListing, DEFAULT_SHIPPING_TWD, type LineInput } from "./checkout-helpers";

const app = exports.default;

/** 以一筆明細結帳，成立一張待付款訂單，回傳訂單編號。 */
export async function placeOrder(cookie: string, lines: LineInput[]): Promise<number> {
  const result = await app.checkout(cookie, checkoutInput(lines));
  if (!result.ok) throw new Error(`結帳失敗：${result.reason}`);
  return result.data.orderId;
}

/** 建立一件商品（單價 320、預設變體在庫 onHand）並替顧客結帳 quantity 件，回傳商品、變體與訂單編號。 */
export async function placeMugOrder(cookie: string, { onHand = 10, quantity = 2 } = {}) {
  const { productId, variantId } = await createStockedListing("馬克杯", 320, onHand);
  const orderId = await placeOrder(cookie, [{ variantId, quantity, seenUnitPriceTwd: 320 }]);
  return { productId, variantId, orderId, totalTwd: 320 * quantity + DEFAULT_SHIPPING_TWD };
}

/** 訂單目前的狀態與付款嘗試（走 RPC 讀取）。 */
export async function orderOf(cookie: string, orderId: number) {
  const found = await app.getMyOrder(cookie, { orderId });
  if (!found.ok) throw new Error(`讀取訂單失敗：${found.reason}`);
  return found.data;
}

/** 變體目前的在庫數與可售數量（管理 RPC 讀取）。 */
export async function stockOf(variantId: number): Promise<{ onHand: number; available: number }> {
  const listed = await app.listProductsForAdmin(await mintAccessJwt());
  const found = listed.ok ? listed.data.flatMap((product) => product.variants).find((variant) => variant.id === variantId) : undefined;
  if (!found) throw new Error("讀取商品失敗");
  return { onHand: found.onHand, available: found.available };
}

/** 發起一筆付款，回傳閘道付款 ID（呼叫端須先 `installFakeGateway`，並設好注入時鐘）。 */
export async function startPaymentFor(cookie: string, orderId: number, gateway: { lastPaymentId(): string }): Promise<string> {
  const started = await app.startPayment(cookie, { orderId });
  if (!started.ok) throw new Error(`發起付款失敗：${started.reason}`);
  return gateway.lastPaymentId();
}

/** 不開立發票的替身：直接建 `createPaymentService` 的測試不關心發票。 */
export const noInvoices = { issueForPayment: async (): Promise<void> => undefined, allowForRefund: async (): Promise<void> => undefined };
