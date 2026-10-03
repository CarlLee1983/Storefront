import { exports } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import { approveOk, paidMixedOrder, requestCancelOk } from "./cancellation-helpers";
import { signInCustomer } from "./customers";
import { resetDb } from "./db";
import { shipItems } from "./loss-helpers";
import { requestReturnOk } from "./return-helpers";
import { adminOrder } from "./shipment-helpers";

const app = exports.default;

beforeEach(resetDb);

/** A11 跨顧客識別碼：鮑伯拿愛麗絲所有資料的識別碼（訂單、批次、申請、地址、信件、聯絡驗證）逐一試過所有顧客端 RPC，一律讀不到、改不動，結果與不存在的編號相同。 */
it("A11 顧客拿別人的訂單、批次、售後申請、地址與信件識別碼：讀不到、動不了，且自己的清單不含別人的資料", async () => {
  const { cookie: alice, orderId, mugLine, tableLine, gateway } = await paidMixedOrder("alice");
  const bob = await signInCustomer("bob");
  const batchId = await shipItems(orderId, [{ orderLineId: mugLine.id, quantity: 2 }]);
  const cancelId = await requestCancelOk(alice, orderId, [{ orderLineId: tableLine.id, quantity: 1 }]);
  await approveOk(cancelId);
  const returnId = await requestReturnOk(alice, orderId, [{ orderLineId: mugLine.id, quantity: 1 }]);
  const address = await app.addAddress(alice, { label: "家", name: "王小明", phone: "0912345678", address: "台北市中正區重慶南路一段 122 號" });
  if (!address.ok) throw new Error("新增地址失敗");
  const addressId = address.data.id;
  const mail = await app.listMyMail(alice);
  if (!mail.ok || mail.data.length === 0) throw new Error("愛麗絲沒有信");
  const messageId = mail.data[0]!.id;
  const refundBefore = (await adminOrder(orderId)).refunds;
  const notFound = { ok: false, reason: "order_not_found" };

  // 訂單：讀取、取消、付款、申請取消與退貨（含用愛麗絲的明細與批次編號）
  expect(await app.getMyOrder(bob, { orderId })).toEqual(notFound);
  expect(await app.cancelOrder(bob, { orderId })).toEqual(notFound);
  expect(await app.startPayment(bob, { orderId })).toMatchObject({ ok: false });
  expect(await app.requestCancellation(bob, { orderId, requestKey: "bob-cancel-key-0001", items: [{ orderLineId: mugLine.id, quantity: 1 }] })).toEqual(notFound);
  expect(await app.requestReturn(bob, { orderId, requestKey: "bob-return-key-0001", items: [{ orderLineId: mugLine.id, shipmentId: batchId, quantity: 1 }] })).toEqual(notFound);
  // 地址與信件：改、刪、讀都與不存在的編號相同
  const absent = addressId + 1000;
  expect(await app.updateAddress(bob, { id: addressId, label: "駭", name: "駭", phone: "0900000000", address: "駭客的家" })).toEqual(await app.updateAddress(bob, { id: absent, label: "駭", name: "駭", phone: "0900000000", address: "駭客的家" }));
  expect(await app.deleteAddress(bob, { id: addressId })).toEqual(await app.deleteAddress(bob, { id: absent }));
  expect(await app.getMyMail(bob, { messageId })).toEqual({ ok: false, reason: "mail_not_found" });
  // 清單：鮑伯看不到愛麗絲的任何訂單、地址與信件
  expect(await app.listMyOrders(bob)).toEqual({ ok: true, data: [] });
  expect(await app.listMyAddresses(bob)).toEqual({ ok: true, data: [] });
  expect(await app.listMyMail(bob)).toEqual({ ok: true, data: [] });
  // 管理 RPC 不能用顧客 cookie 代替管理員身分
  expect(await app.getOrderForAdmin(bob, { orderId })).toEqual({ ok: false, reason: "unauthorized" });
  expect(await app.decideReturn(bob, { requestId: returnId, decision: "approve", note: "" })).toEqual({ ok: false, reason: "unauthorized" });
  expect(await app.retryRefund(bob, { refundId: refundBefore[0]!.id })).toEqual({ ok: false, reason: "unauthorized" });

  // 愛麗絲的資料一個字都沒動
  const after = await adminOrder(orderId);
  expect(after.refunds).toEqual(refundBefore);
  expect(after.status).not.toBe("cancelled");
  expect(await app.listMyAddresses(alice)).toMatchObject({ ok: true, data: [{ id: addressId, name: "王小明" }] });
  expect(await app.getMyMail(alice, { messageId })).toMatchObject({ ok: true });
  expect(gateway.refundRequests.length).toBe(refundBefore.filter((refund) => refund.status === "succeeded").length);
});
