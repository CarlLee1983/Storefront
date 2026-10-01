import { exports } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import { mintAccessJwt } from "./access";
import { assignDefaultCategory } from "./categories";
import { resetDb } from "./db";
import { imageVariants } from "./images";
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
  await app.adjustStock(jwt, { id, delta: 3 });
  const reordered = [images[2]!, images[0]!, images[1]!];
  expect((await app.reorderProductImages(jwt, { id, imageIds: reordered.map(image => image.id) })).ok).toBe(true);
  expect(await app.getProduct({ id })).toEqual({ ok: true, data: {
    id, name: "陶瓷花器", description: "手工製作\n每件紋理不同", priceTwd: 680, purchasable: true, images: reordered, category: { slug: "default", name: "預設分類" },
  } });
  await app.adjustStock(jwt, { id, delta: -3 });
  expect(await app.getProduct({ id })).toMatchObject({ ok: true, data: { purchasable: false } });
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
