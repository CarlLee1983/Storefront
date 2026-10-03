import { exports } from "cloudflare:workers";
import { mintAccessJwt } from "./access";
import { checkoutInput, createStockedListing, newKey } from "./checkout-helpers";
import { signInCustomer } from "./customers";
import { installFakeGateway, type FakeGateway } from "./fake-gateway";
import { startPaymentFor } from "./payment-helpers";
import { adminOrder } from "./shipment-helpers";

const app = exports.default;

export interface PaidMixedOrder {
  cookie: string;
  orderId: number;
  gateway: FakeGateway;
  totalTwd: number;
  mugVariantId: number;
  tableVariantId: number;
  /** 馬克杯（一般，單價 320）、餐桌（大型，單價 6000）的訂單明細。 */
  mugLine: { id: number; quantity: number };
  tableLine: { id: number; quantity: number };
}

/**
 * 走完整付款流程成立一張已付款的混合訂單：馬克杯 3 件（一般配送，運費 100）、餐桌 1 件（大型配送，運費 600），
 * 付款成功後訂單由這筆付款支付（取消退款綁定它）。總額 960 + 6000 + 700 = 7660。`beforePayment` 在付款成功之前對閘道注入情境（例如讓開立發票失敗）。
 */
export async function paidMixedOrder(name = "alice", { beforePayment }: { beforePayment?: (gateway: FakeGateway) => void } = {}): Promise<PaidMixedOrder> {
  const cookie = await signInCustomer(name);
  const mug = await createStockedListing("馬克杯", 320, 10);
  const table = await createStockedListing("餐桌", 6000, 5, "large");
  const placed = await app.checkout(cookie, checkoutInput([
    { variantId: mug.variantId, quantity: 3, seenUnitPriceTwd: 320 },
    { variantId: table.variantId, quantity: 1, seenUnitPriceTwd: 6000 },
  ], newKey(), 700));
  if (!placed.ok) throw new Error(`結帳失敗：${placed.reason}`);
  const orderId = placed.data.orderId;
  const gateway = installFakeGateway();
  beforePayment?.(gateway);
  const gatewayPaymentId = await startPaymentFor(cookie, orderId, gateway);
  const applied = await app.applyPaymentResult(gateway.settle(gatewayPaymentId, "succeeded"));
  if (!applied.ok || applied.data.orderStatus !== "paid") throw new Error("付款未使訂單轉為已付款");
  const order = await adminOrder(orderId);
  const lineOf = (variantId: number) => {
    const line = order.lines.find((candidate) => candidate.variantId === variantId)!;
    return { id: line.id, quantity: line.quantity };
  };
  return { cookie, orderId, gateway, totalTwd: placed.data.totalTwd, mugVariantId: mug.variantId, tableVariantId: table.variantId, mugLine: lineOf(mug.variantId), tableLine: lineOf(table.variantId) };
}

/** 顧客申請取消；`key` 不給就用新的冪等鍵。回傳 RPC 結果原樣。 */
export function requestCancel(cookie: string, orderId: number, items: { orderLineId: number; quantity: number }[], extra: Record<string, unknown> = {}) {
  return app.requestCancellation(cookie, { orderId, requestKey: newKey(), items, ...extra });
}

/** 顧客申請取消並要求成功，回傳申請編號。 */
export async function requestCancelOk(cookie: string, orderId: number, items: { orderLineId: number; quantity: number }[]): Promise<number> {
  const result = await requestCancel(cookie, orderId, items);
  if (!result.ok) throw new Error(`申請取消失敗：${result.reason}`);
  return result.data.requestId;
}

/** 管理員審核一案取消申請。 */
export async function decide(requestId: number, decision: "approve" | "reject", note = "") {
  return app.decideCancellation(await mintAccessJwt(), { requestId, decision, note });
}

/** 管理員核准並要求成功，回傳結果資料。 */
export async function approveOk(requestId: number) {
  const result = await decide(requestId, "approve");
  if (!result.ok) throw new Error(`核准失敗：${result.reason}`);
  return result.data;
}
