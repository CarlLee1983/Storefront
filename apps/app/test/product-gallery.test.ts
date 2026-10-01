import { env, exports } from "cloudflare:workers";
import { beforeEach, expect, it, vi } from "vitest";
import { createAdminService } from "../src/admin/service";
import { cleanupDeletedProductImages } from "../src/images/manage";
import type { ProductImageBucket } from "../src/images/upload";
import { systemClock } from "../src/shared/clock";
import { mintAccessJwt } from "./access";
import { assignDefaultCategory } from "./categories";
import { resetDb } from "./db";
import { imageVariants } from "./images";
const app = exports.default;
beforeEach(resetDb);
async function fixture(count = 3) {
  const jwt = await mintAccessJwt();
  const created = await app.createProduct(jwt, { name: "圖庫商品", description: "", priceTwd: 100 });
  if (!created.ok) throw new Error("create");
  const id = created.data.id;
  const images = [];
  for (let n = 0; n < count; n++) {
    const result = await app.addProductImage(jwt, { id, uploadId: crypto.randomUUID(), variants: imageVariants() });
    if (!result.ok) throw new Error("upload");
    images.push(result.data.image);
  }
  return { jwt, id, images };
}
async function imageIds(jwt: string, id: number) {
  const result = await app.getProductForAdmin(jwt, { id });
  if (!result.ok) throw new Error("get");
  return result.data.images.map(image => image.id);
}
it("reorders a full eight-image set and changes customer/admin covers", async () => {
  const { jwt, id, images } = await fixture(8);
  await assignDefaultCategory(jwt, id);
  await app.relistProduct(jwt, { id });
  const reversed = [...images].reverse();
  expect(await app.reorderProductImages(jwt, { id, imageIds: reversed.map(image => image.id) })).toEqual({ ok: true, data: { id } });
  expect(await imageIds(jwt, id)).toEqual(reversed.map(image => image.id));
  expect(await app.listProducts()).toMatchObject({ ok: true, data: { items: [{ cover: reversed[0] }] } });
  expect(await app.listProductsForAdmin(jwt)).toMatchObject({ ok: true, data: [{ cover: reversed[0] }] });
});
it("rejects incomplete, foreign, duplicate, malformed, and stale image sets without changing the order", async () => {
  const { jwt, id, images } = await fixture();
  const ids = images.map(image => image.id);
  for (const invalid of [ids.slice(1), [], [...ids, crypto.randomUUID()], [crypto.randomUUID(), ...ids.slice(1)]]) {
    expect(await app.reorderProductImages(jwt, { id, imageIds: invalid })).toEqual({ ok: false, reason: "image_set_changed" });
    expect(await imageIds(jwt, id)).toEqual(ids);
  }
  for (const invalid of [[ids[0], ids[0], ids[2]], ["bad"], Array(9).fill(crypto.randomUUID())]) {
    expect(await app.reorderProductImages(jwt, { id, imageIds: invalid })).toMatchObject({ ok: false, reason: "invalid_input" });
  }
  expect(await app.reorderProductImages(jwt, { id: 999999, imageIds: [] })).toEqual({ ok: false, reason: "product_not_found" });
  await app.deleteProductImage(jwt, { id, imageId: ids[1] });
  expect(await app.reorderProductImages(jwt, { id, imageIds: ids })).toEqual({ ok: false, reason: "image_set_changed" });
});
it("rejects unauthenticated gallery mutations before writes and validates deletion input", async () => {
  const { jwt, id, images } = await fixture();
  const ids = images.map(image => image.id);
  expect(await app.reorderProductImages("", { id, imageIds: [...ids].reverse() })).toEqual({ ok: false, reason: "unauthorized" });
  expect(await app.deleteProductImage("", { id, imageId: ids[0] })).toEqual({ ok: false, reason: "unauthorized" });
  expect(await app.deleteProductImage(jwt, { id, imageId: "bad" })).toMatchObject({ ok: false, reason: "invalid_input" });
  expect(await imageIds(jwt, id)).toEqual(ids);
  for (const image of images) expect(await env.PRODUCT_IMAGES.get(image.variants[0]!.key)).not.toBeNull();
});
it("deletes all R2 variants, compacts positions, and appends a replacement after a full gallery", async () => {
  const { jwt, id, images } = await fixture(8);
  const removed = images[3]!;
  expect(await app.deleteProductImage(jwt, { id, imageId: removed.id })).toEqual({ ok: true, data: { id, imageId: removed.id } });
  for (const variant of removed.variants) expect(await env.PRODUCT_IMAGES.get(variant.key)).toBeNull();
  const replacement = await app.addProductImage(jwt, { id, uploadId: crypto.randomUUID(), variants: imageVariants() });
  if (!replacement.ok) throw new Error("replacement failed");
  expect(await imageIds(jwt, id)).toEqual([...images.filter(image => image.id !== removed.id).map(image => image.id), replacement.data.image.id]);
  expect(await env.PRODUCT_IMAGES.get(images[0]!.variants[0]!.key)).not.toBeNull();
  expect(await app.addProductImage(jwt, { id, uploadId: crypto.randomUUID(), variants: imageVariants() })).toEqual({ ok: false, reason: "image_limit" });
});
it("concurrent deletions retain the final listed image; unlisted products can have zero", async () => {
  const { jwt, id, images } = await fixture();
  await assignDefaultCategory(jwt, id);
  await app.relistProduct(jwt, { id });
  const results = await Promise.all(images.map(image => app.deleteProductImage(jwt, { id, imageId: image.id })));
  expect(results.filter(result => result.ok)).toHaveLength(2);
  expect(results.filter(result => !result.ok)).toEqual([{ ok: false, reason: "last_product_image" }]);
  const [last] = await imageIds(jwt, id);
  expect(await app.listProducts()).toMatchObject({ ok: true, data: { items: [{ cover: { id: last } }] } });
  const survivor = images.find(image => image.id === last)!;
  for (const variant of survivor.variants) expect(await env.PRODUCT_IMAGES.get(variant.key)).not.toBeNull();
  await app.unlistProduct(jwt, { id });
  expect((await app.deleteProductImage(jwt, { id, imageId: last })).ok).toBe(true);
  expect(await imageIds(jwt, id)).toEqual([]);
  expect(await app.reorderProductImages(jwt, { id, imageIds: [] })).toEqual({ ok: true, data: { id } });
  expect(await app.relistProduct(jwt, { id })).toEqual({ ok: false, reason: "no_images" });
  expect(await app.listProductsForAdmin(jwt)).toMatchObject({ ok: true, data: [{ cover: null }] });
});
it("deletion retries and wrong-product image IDs never delete another product's objects", async () => {
  const { jwt, id, images } = await fixture(1);
  const other = await fixture(1);
  expect((await app.deleteProductImage(jwt, { id, imageId: other.images[0]!.id })).ok).toBe(true);
  expect(await imageIds(jwt, other.id)).toEqual([other.images[0]!.id]);
  expect(await env.PRODUCT_IMAGES.get(other.images[0]!.variants[0]!.key)).not.toBeNull();
  expect(await app.deleteProductImage(jwt, { id: 999999, imageId: images[0]!.id })).toEqual({ ok: false, reason: "product_not_found" });
  const input = { id, imageId: images[0]!.id };
  expect((await app.deleteProductImage(jwt, input)).ok).toBe(true);
  expect((await app.deleteProductImage(jwt, input)).ok).toBe(true);
});
it("R2 cleanup failures are durable and retryable, never leaving a broken referenced cover", async () => {
  const { jwt, id, images } = await fixture(2);
  await assignDefaultCategory(jwt, id);
  await app.relistProduct(jwt, { id });
  const bucket = { put: vi.fn(), delete: vi.fn().mockRejectedValue(new Error("R2 unavailable")) };
  const service = createAdminService(env.DB, systemClock, { teamDomain: env.ACCESS_TEAM_DOMAIN, audience: env.ACCESS_AUD, jwksJson: env.ACCESS_JWKS_JSON }, bucket as unknown as ProductImageBucket);
  const input = { id, imageId: images[0]!.id };
  expect(await service.deleteProductImage(jwt, input)).toEqual({ ok: false, reason: "image_delete_failed" });
  expect(await imageIds(jwt, id)).toEqual([images[1]!.id]);
  expect(await app.listProducts()).toMatchObject({ ok: true, data: { items: [{ cover: images[1] }] } });
  await cleanupDeletedProductImages(env.DB, undefined);
  await cleanupDeletedProductImages(env.DB, bucket as unknown as ProductImageBucket);
  expect((await app.deleteProductImage(jwt, input)).ok).toBe(true);
  for (const variant of images[0]!.variants) expect(await env.PRODUCT_IMAGES.get(variant.key)).toBeNull();
  // The scheduled retry also clears a later cleanup failure after the UI closes.
  await app.unlistProduct(jwt, { id });
  expect((await service.deleteProductImage(jwt, { id, imageId: images[1]!.id })).ok).toBe(false);
  await cleanupDeletedProductImages(env.DB, env.PRODUCT_IMAGES);
  for (const variant of images[1]!.variants) expect(await env.PRODUCT_IMAGES.get(variant.key)).toBeNull();
});
it("concurrent reorder, delete and append preserve an exact ordered gallery", async () => {
  const { jwt, id, images } = await fixture(7);
  await Promise.all([
    app.reorderProductImages(jwt, { id, imageIds: [...images].reverse().map(image => image.id) }),
    app.deleteProductImage(jwt, { id, imageId: images[2]!.id }),
    app.addProductImage(jwt, { id, uploadId: crypto.randomUUID(), variants: imageVariants() }),
  ]);
  const ids = await imageIds(jwt, id);
  expect(ids).toHaveLength(7); expect(new Set(ids).size).toBe(7); expect(ids).not.toContain(images[2]!.id);
  expect((await app.reorderProductImages(jwt, { id, imageIds: [...ids].reverse() })).ok).toBe(true);
  expect(await imageIds(jwt, id)).toEqual([...ids].reverse());
});
it("concurrent relist and final deletion cannot leave a listed product without a cover", async () => {
  const { jwt, id, images } = await fixture(1);
  await assignDefaultCategory(jwt, id);
  await Promise.all([
    app.relistProduct(jwt, { id }),
    app.deleteProductImage(jwt, { id, imageId: images[0]!.id }),
  ]);
  const detail = await app.getProductForAdmin(jwt, { id });
  if (!detail.ok) throw new Error("missing");
  expect(detail.data.listed && detail.data.images.length === 0).toBe(false);
  if (detail.data.images.length) expect(await env.PRODUCT_IMAGES.get(detail.data.images[0]!.variants[0]!.key)).not.toBeNull();
});
it("a committed D1 deletion with a lost response is recoverable without touching the new cover", async () => {
  const { jwt, id, images } = await fixture(2);
  await assignDefaultCategory(jwt, id);
  await app.relistProduct(jwt, { id });
  const d1 = { prepare: (sql: string) => env.DB.prepare(sql), batch: async (statements: D1PreparedStatement[]) => { await env.DB.batch(statements); throw new Error("response lost"); } } as unknown as D1Database;
  const service = createAdminService(d1, systemClock, { teamDomain: env.ACCESS_TEAM_DOMAIN, audience: env.ACCESS_AUD, jwksJson: env.ACCESS_JWKS_JSON }, env.PRODUCT_IMAGES);
  const input = { id, imageId: images[0]!.id };
  expect(await service.deleteProductImage(jwt, input)).toEqual({ ok: false, reason: "image_delete_failed" });
  expect(await imageIds(jwt, id)).toEqual([images[1]!.id]);
  expect((await app.deleteProductImage(jwt, input)).ok).toBe(true);
  for (const variant of images[0]!.variants) expect(await env.PRODUCT_IMAGES.get(variant.key)).toBeNull();
  expect(await env.PRODUCT_IMAGES.get(images[1]!.variants[0]!.key)).not.toBeNull();
});
it("cleanup tombstone response loss and missing bucket are safe to retry", async () => {
  const { jwt, id, images } = await fixture(1);
  const access = { teamDomain: env.ACCESS_TEAM_DOMAIN, audience: env.ACCESS_AUD, jwksJson: env.ACCESS_JWKS_JSON };
  const input = { id, imageId: images[0]!.id };
  const unavailable = createAdminService(env.DB, systemClock, access);
  expect(await unavailable.deleteProductImage(jwt, input)).toEqual({ ok: false, reason: "image_delete_failed" });
  expect(await imageIds(jwt, id)).toEqual([images[0]!.id]);
  const d1 = { batch: (statements: D1PreparedStatement[]) => env.DB.batch(statements), prepare: (sql: string) => {
    const statement = env.DB.prepare(sql);
    if (!sql.startsWith("DELETE FROM product_image_deletions")) return statement;
    return { bind: (...values: unknown[]) => ({ run: async () => { await statement.bind(...values).run(); throw new Error("response lost"); } }) };
  } } as unknown as D1Database;
  const service = createAdminService(d1, systemClock, access, env.PRODUCT_IMAGES);
  expect(await service.deleteProductImage(jwt, input)).toEqual({ ok: false, reason: "image_delete_failed" });
  expect((await app.deleteProductImage(jwt, input)).ok).toBe(true);
  for (const variant of images[0]!.variants) expect(await env.PRODUCT_IMAGES.get(variant.key)).toBeNull();
});
