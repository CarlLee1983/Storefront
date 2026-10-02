import { exports } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import { mintAccessJwt } from "./access";
import { defaultVariantIdOf } from "./checkout-helpers";
import { assignCategory, assignDefaultCategory, createCategory } from "./categories";
import { resetDb } from "./db";
import { setNow } from "./clock";
import { imageVariants, uploadAndList } from "./images";
const app = exports.default;
beforeEach(resetDb);

async function fixture() {
  const jwt = await mintAccessJwt();
  const created = await app.createProduct(jwt, { name: "陶瓷花器", description: "手工製作\n每件紋理不同", priceTwd: 680 });
  if (!created.ok) throw new Error("create");
  const id = created.data.id;
  const images = [];
  for (let n = 0; n < 3; n++) {
    const uploaded = await app.addProductImage(jwt, { id, uploadId: crypto.randomUUID(), variants: imageVariants() });
    if (!uploaded.ok) throw new Error("upload");
    images.push(uploaded.data.image);
  }
  return { id, jwt, images };
}
it("public detail returns listed product and current ordered gallery without inventory internals", async () => {
  const { id, jwt, images } = await fixture();
  await assignDefaultCategory(jwt, id);
  await app.relistProduct(jwt, { id });
  await app.adjustStock(jwt, { variantId: await defaultVariantIdOf(id), delta: 3 });
  const reordered = [images[2]!, images[0]!, images[1]!];
  expect((await app.reorderProductImages(jwt, { id, imageIds: reordered.map(image => image.id) })).ok).toBe(true);
  expect(await app.getProduct({ id })).toEqual({ ok: true, data: {
    id, name: "陶瓷花器", description: "手工製作\n每件紋理不同", defaultVariantId: expect.any(Number), priceTwd: 680, compareAtPriceTwd: null, purchasable: true, available: 3, images: reordered, category: { slug: "default", name: "預設分類" }, related: [],
  } });
  await app.adjustStock(jwt, { variantId: await defaultVariantIdOf(id), delta: -3 });
  expect(await app.getProduct({ id })).toMatchObject({ ok: true, data: { purchasable: false, available: 0 } });
});
it("new and unlisted products are indistinguishable from a nonexistent product", async () => {
  const { id, jwt } = await fixture();
  expect(await app.getProduct({ id })).toEqual({ ok: false, reason: "not_found" });
  await assignDefaultCategory(jwt, id);
  await app.relistProduct(jwt, { id });
  await app.unlistProduct(jwt, { id });
  expect(await app.getProduct({ id })).toEqual({ ok: false, reason: "not_found" });
  expect(await app.getProduct({ id: 999999 })).toEqual({ ok: false, reason: "not_found" });
});
it.each([null, undefined, {}, "1", { id: "1" }, { id: 0 }, { id: -1 }, { id: 1.5 }, { id: NaN }, { id: Infinity }, { id: Number.MAX_SAFE_INTEGER + 1 }])("malformed public identifiers do not expose products: %j", async input => {
  expect(await app.getProduct(input)).toEqual({ ok: false, reason: "not_found" });
});

async function listedIn(jwt: string, categoryId: number, name: string) {
  const created = await app.createProduct(jwt, { name, description: `${name}的說明`, priceTwd: 500 });
  if (!created.ok) throw new Error("新增商品失敗");
  await assignCategory(jwt, created.data.id, categoryId);
  await uploadAndList(jwt, created.data.id);
  return created.data.id;
}
const relatedIds = async (id: number) => {
  const found = await app.getProduct({ id });
  if (!found.ok) throw new Error("商品不存在");
  return found.data.related.map(item => item.id);
};
it("related 是同分類的其他上架商品：不含自己與下架、其他分類，依上架時間新到舊，沿用商品項目形狀", async () => {
  const jwt = await mintAccessJwt();
  const living = await createCategory(jwt, "living", "客廳", "沙發");
  const dining = await createCategory(jwt, "dining", "餐廳", "餐桌");
  setNow(1_000);
  const self = await listedIn(jwt, living, "自己");
  setNow(2_000);
  const older = await listedIn(jwt, living, "較舊");
  setNow(3_000);
  const hidden = await listedIn(jwt, living, "下架");
  await listedIn(jwt, dining, "別的分類");
  await app.unlistProduct(jwt, { id: hidden });
  setNow(4_000);
  const newer = await listedIn(jwt, living, "較新");
  expect(await relatedIds(self)).toEqual([newer, older]);
  const found = await app.getProduct({ id: self });
  expect(found).toMatchObject({ ok: true, data: { related: [{ id: newer, name: "較新", priceTwd: 500, compareAtPriceTwd: null, purchasable: false, cover: { variants: expect.any(Array) } }, { id: older }] } });
});
it("related 最多 4 件，留下上架時間最新的", async () => {
  const jwt = await mintAccessJwt();
  const living = await createCategory(jwt);
  const ids: number[] = [];
  for (let n = 0; n < 6; n++) {
    setNow(1_000 + n * 1_000);
    ids.push(await listedIn(jwt, living, `商品${n}`));
  }
  expect(await relatedIds(ids[0]!)).toEqual([ids[5], ids[4], ids[3], ids[2]]);
});
