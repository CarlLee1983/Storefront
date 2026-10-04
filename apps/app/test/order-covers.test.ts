import { exports } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import type { ProductImage } from "../src/product-images";
import { mintAccessJwt } from "./access";
import { signInCustomer } from "./customers";
import { resetDb } from "./db";
import { imageVariants } from "./images";
import { placeMugOrder } from "./payment-helpers";

const app = exports.default;
beforeEach(resetDb);

it("顧客與管理員的清單、詳情讀取現在封面；換封面、下架與刪圖不改訂單快照", async () => {
  const cookie = await signInCustomer("alice");
  const jwt = await mintAccessJwt();
  const { productId: id, orderId } = await placeMugOrder(cookie);
  const product = await app.getProductForAdmin(jwt, { id });
  if (!product.ok) throw new Error("讀取商品失敗");
  const first = product.data.images[0]!;
  const second = await app.addProductImage(jwt, { id, uploadId: crypto.randomUUID(), variants: imageVariants() });
  if (!second.ok) throw new Error("新增商品圖片失敗");
  async function expectCover(cover: ProductImage | null) {
    const line = { productId: id, productName: "馬克杯", quantity: 2, unitPriceTwd: 320, cover };
    expect(await app.getMyOrder(cookie, { orderId })).toMatchObject({ ok: true, data: { lines: [line] } });
    expect(await app.listMyOrders(cookie)).toMatchObject({ ok: true, data: [{ id: orderId, lines: [line] }] });
    expect(await app.getOrderForAdmin(jwt, { orderId })).toMatchObject({ ok: true, data: { lines: [line] } });
    expect(await app.listOrdersForAdmin(jwt, {})).toMatchObject({ ok: true, data: { items: [{ id: orderId, lines: [line] }] } });
  }
  await expectCover(first);
  expect(await app.reorderProductImages(jwt, { id, imageIds: [second.data.image.id, first.id] })).toMatchObject({ ok: true });
  await expectCover(second.data.image);
  expect(await app.unlistProduct(jwt, { id })).toMatchObject({ ok: true });
  await expectCover(second.data.image);
  expect(await app.deleteProductImage(jwt, { id, imageId: second.data.image.id })).toMatchObject({ ok: true });
  await expectCover(first);
  expect(await app.deleteProductImage(jwt, { id, imageId: first.id })).toMatchObject({ ok: true });
  await expectCover(null);
});
