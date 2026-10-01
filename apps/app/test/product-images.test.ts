import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAdminService } from "../src/admin/service";
import { systemClock } from "../src/shared/clock";
import { MAX_IMAGE_BYTES } from "../src/product-images";
import type { ProductImageBucket } from "../src/images/upload";
import { mintAccessJwt } from "./access";
import { resetDb } from "./db";
import { imageVariants } from "./images";

const app = exports.default;
const access = () => ({ teamDomain: env.ACCESS_TEAM_DOMAIN, audience: env.ACCESS_AUD, jwksJson: env.ACCESS_JWKS_JSON });
async function createProduct(jwt: string) {
  const result = await app.createProduct(jwt, { name: "商品圖片測試", description: "", priceTwd: 100 });
  if (!result.ok) throw new Error("create failed");
  return result.data.id;
}
function fakeBucket() {
  const objects = new Map<string, Uint8Array>();
  const bucket = {
    put: vi.fn(async (key: string, bytes: Uint8Array) => { objects.set(key, bytes); return {}; }),
    delete: vi.fn(async (keys: string | string[]) => { for (const key of typeof keys === "string" ? [keys] : keys) objects.delete(key); }),
  };
  return { objects, bucket, serviceBucket: bucket as unknown as ProductImageBucket };
}
function failInsert() {
  return { prepare: vi.fn((sql: string) => sql.includes("INSERT INTO product_images")
    ? { bind: () => ({ first: async () => { throw new Error("D1 write failed"); } }) }
    : env.DB.prepare(sql)) } as unknown as D1Database;
}

beforeEach(resetDb);

describe("商品圖片 RPC", () => {
  it("沒有圖片不能上架；上傳後能上架、取得封面與全部尺寸", async () => {
    const jwt = await mintAccessJwt();
    const id = await createProduct(jwt);
    expect(await app.relistProduct(jwt, { id })).toEqual({ ok: false, reason: "no_images" });
    expect(await app.getProductForAdmin(jwt, { id })).toMatchObject({ ok: true, data: { listed: false, images: [] } });
    const variants = imageVariants();
    const added = await app.addProductImage(jwt, { id, uploadId: crypto.randomUUID(), variants: [...variants].reverse() });
    expect(added.ok).toBe(true);
    if (!added.ok) throw new Error("upload failed");
    expect(added.data.image.variants.map((variant) => variant.width)).toEqual([320, 640, 1280]);
    for (const [index, variant] of added.data.image.variants.entries()) {
      expect(variant.key).toMatch(new RegExp(`^products/${id}/${added.data.image.id}/[a-f0-9]{64}\\.webp$`));
      const object = await env.PRODUCT_IMAGES.get(variant.key);
      expect(object?.httpMetadata?.contentType).toBe("image/webp");
      expect(new Uint8Array(await object!.arrayBuffer())).toEqual(variants[index]!.bytes);
      const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", variants[index]!.bytes))].map((value) => value.toString(16).padStart(2, "0")).join("");
      expect(variant.key.endsWith(`/${digest}.webp`)).toBe(true);
    }
    expect((await env.PRODUCT_IMAGES.list({ prefix: `products/${id}/${added.data.image.id}/` })).objects).toHaveLength(3);
    expect(await app.relistProduct(jwt, { id })).toEqual({ ok: true, data: { id } });
    expect(await app.listProducts()).toMatchObject({ ok: true, data: [{ id, cover: added.data.image }] });
    expect(await app.getProductForAdmin(jwt, { id })).toMatchObject({ ok: true, data: { images: [added.data.image] } });
  });

  it("多張圖片按加入順序排列，封面是第一張", async () => {
    const jwt = await mintAccessJwt();
    const id = await createProduct(jwt);
    const one = await app.addProductImage(jwt, { id, uploadId: crypto.randomUUID(), variants: imageVariants() });
    const two = await app.addProductImage(jwt, { id, uploadId: crypto.randomUUID(), variants: imageVariants() });
    if (!one.ok || !two.ok) throw new Error("upload failed");
    expect(one.data.image.variants[0]!.key).not.toBe(two.data.image.variants[0]!.key);
    await app.relistProduct(jwt, { id });
    expect(await app.listProducts()).toMatchObject({ ok: true, data: [{ cover: one.data.image }] });
    expect(await app.getProductForAdmin(jwt, { id })).toMatchObject({ ok: true, data: { images: [one.data.image, two.data.image] } });
    await app.unlistProduct(jwt, { id });
    expect(await app.listProducts()).toEqual({ ok: true, data: [] });
    expect(await env.PRODUCT_IMAGES.get(one.data.image.variants[0]!.key)).not.toBeNull();
  });

  it("並行上傳至多 8 張；敗方只清理自己寫的物件", async () => {
    const jwt = await mintAccessJwt();
    const id = await createProduct(jwt);
    const { serviceBucket, objects, bucket } = fakeBucket();
    const service = createAdminService(env.DB, systemClock, access(), serviceBucket);
    const results = await Promise.all(Array.from({ length: 10 }, () => service.addProductImage(jwt, { id, uploadId: crypto.randomUUID(), variants: imageVariants() })));
    expect(results.filter((result) => result.ok)).toHaveLength(8);
    expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, reason: "image_limit" }, { ok: false, reason: "image_limit" }]);
    expect(objects.size).toBe(24);
    expect(await app.getProductForAdmin(jwt, { id })).toMatchObject({ ok: true, data: { images: expect.any(Array) } });
    const detail = await app.getProductForAdmin(jwt, { id });
    expect(detail.ok && detail.data.images.length).toBe(8);
    bucket.put.mockClear();
    expect(await service.addProductImage(jwt, { id, uploadId: crypto.randomUUID(), variants: imageVariants() })).toEqual({ ok: false, reason: "image_limit" });
    expect(bucket.put).not.toHaveBeenCalled();
  });

  it("回應遺失後重試相同 uploadId 回原圖片，不再寫 R2 或多占一格", async () => {
    const jwt = await mintAccessJwt();
    const id = await createProduct(jwt);
    const { bucket, objects, serviceBucket } = fakeBucket();
    const service = createAdminService(env.DB, systemClock, access(), serviceBucket);
    const input = { id, uploadId: crypto.randomUUID(), variants: imageVariants() };
    const first = await service.addProductImage(jwt, input);
    bucket.put.mockClear();
    expect(await service.addProductImage(jwt, input)).toEqual(first);
    expect(bucket.put).not.toHaveBeenCalled();
    expect(objects.size).toBe(3);
    const detail = await app.getProductForAdmin(jwt, { id });
    expect(detail.ok && detail.data.images.length).toBe(1);
    for (let i = 0; i < 7; i++) {
      expect((await service.addProductImage(jwt, { ...input, uploadId: crypto.randomUUID() })).ok).toBe(true);
    }
    expect(await service.addProductImage(jwt, input)).toEqual(first);
  });

  it("同一 uploadId 並行重試只儲存一張，失敗嘗試的清理不碰勝方物件", async () => {
    const jwt = await mintAccessJwt();
    const id = await createProduct(jwt);
    const { serviceBucket, objects } = fakeBucket();
    const service = createAdminService(env.DB, systemClock, access(), serviceBucket);
    const input = { id, uploadId: crypto.randomUUID(), variants: imageVariants() };
    const results = await Promise.all(Array.from({ length: 5 }, () => service.addProductImage(jwt, input)));
    expect(results.every((result) => result.ok)).toBe(true);
    for (const result of results) expect(result).toEqual(results[0]);
    expect(objects.size).toBe(3);
    const detail = await app.getProductForAdmin(jwt, { id });
    expect(detail.ok && detail.data.images.length).toBe(1);
    if (!results[0]!.ok) throw new Error("upload failed");
    expect([...objects.keys()].sort()).toEqual(results[0]!.data.image.variants.map((variant) => variant.key).sort());
  });

  it("同 uploadId 不同內容被拒絕；不同商品可獨立使用同一 uploadId", async () => {
    const jwt = await mintAccessJwt();
    const id = await createProduct(jwt);
    const secondId = await createProduct(jwt);
    const { serviceBucket, bucket } = fakeBucket();
    const service = createAdminService(env.DB, systemClock, access(), serviceBucket);
    const input = { id, uploadId: crypto.randomUUID(), variants: imageVariants() };
    expect((await service.addProductImage(jwt, input)).ok).toBe(true);
    const changed = imageVariants();
    const last = changed[0]!.bytes.length - 1;
    changed[0]!.bytes[last] = changed[0]!.bytes[last]! ^ 1;
    bucket.put.mockClear();
    expect(await service.addProductImage(jwt, { ...input, variants: changed })).toMatchObject({ ok: false, reason: "invalid_input", fields: { uploadId: expect.any(Array) } });
    expect(bucket.put).not.toHaveBeenCalled();
    expect((await service.addProductImage(jwt, { ...input, id: secondId })).ok).toBe(true);
  });

  it("uploadId 缺漏或不是 UUID 被拒絕且沒有寫入", async () => {
    const jwt = await mintAccessJwt();
    const id = await createProduct(jwt);
    const { serviceBucket, bucket } = fakeBucket();
    const service = createAdminService(env.DB, systemClock, access(), serviceBucket);
    for (const uploadId of [undefined, "invalid", 1]) {
      expect(await service.addProductImage(jwt, { id, uploadId, variants: imageVariants() })).toMatchObject({ ok: false, reason: "invalid_input" });
    }
    expect(bucket.put).not.toHaveBeenCalled();
  });

  it("不存在的商品不寫 R2", async () => {
    const jwt = await mintAccessJwt();
    const { bucket, serviceBucket } = fakeBucket();
    const service = createAdminService(env.DB, systemClock, access(), serviceBucket);
    expect(await service.addProductImage(jwt, { id: 999999, uploadId: crypto.randomUUID(), variants: imageVariants() })).toEqual({ ok: false, reason: "product_not_found" });
    expect(bucket.put).not.toHaveBeenCalled();
  });

  it("未授權先拒絕，連格式驗證、D1 與 R2 都不觸及", async () => {
    const { bucket, serviceBucket } = fakeBucket();
    const prepare = vi.fn();
    const service = createAdminService({ prepare } as unknown as D1Database, systemClock, access(), serviceBucket);
    expect(await service.addProductImage("", null)).toEqual({ ok: false, reason: "unauthorized" });
    expect(await service.addProductImage("", { id: 1, uploadId: crypto.randomUUID(), variants: imageVariants() })).toEqual({ ok: false, reason: "unauthorized" });
    expect(prepare).not.toHaveBeenCalled();
    expect(bucket.put).not.toHaveBeenCalled();
    expect(bucket.delete).not.toHaveBeenCalled();
  });

  it.each([
    ["missing size", () => imageVariants().slice(0, 2)],
    ["duplicate size", () => { const values = imageVariants(); values[2] = values[0]!; return values; }],
    ["oversize file", () => { const values = imageVariants(); values[0]!.bytes = new Uint8Array(MAX_IMAGE_BYTES + 1); return values; }],
    ["non-WebP", () => { const values = imageVariants(); values[0]!.bytes = new Uint8Array(new TextEncoder().encode("not an image")); return values; }],
    ["mismatched dimensions", () => { const values = imageVariants(); values[0]!.height += 1; return values; }],
    ["excessive dimensions", () => { const values = imageVariants(); values[0]!.height = 8193; return values; }],
    ["missing bytes", () => [{ width: 320, height: 240 }, ...imageVariants().slice(1)]],
    ["empty bytes", () => { const values = imageVariants(); values[0]!.bytes = new Uint8Array(); return values; }],
  ])("%s 回 invalid_input，沒有任何寫入", async (_label, variants) => {
    const jwt = await mintAccessJwt();
    const id = await createProduct(jwt);
    const { serviceBucket, bucket } = fakeBucket();
    const service = createAdminService(env.DB, systemClock, access(), serviceBucket);
    expect(await service.addProductImage(jwt, { id, uploadId: crypto.randomUUID(), variants: variants() })).toMatchObject({ ok: false, reason: "invalid_input" });
    expect(bucket.put).not.toHaveBeenCalled();
    expect(await app.getProductForAdmin(jwt, { id })).toMatchObject({ ok: true, data: { images: [] } });
  });
});

describe("R2 / D1 失敗時清理", () => {
  it("R2 部分失敗後盡力清理，D1 不留下圖片", async () => {
    const jwt = await mintAccessJwt();
    const id = await createProduct(jwt);
    const { serviceBucket, bucket, objects } = fakeBucket();
    bucket.put.mockImplementationOnce(async (key, bytes) => { objects.set(key, bytes); return {}; })
      .mockImplementationOnce(async (key, bytes) => { objects.set(key, bytes); throw new Error("R2 write failed"); });
    const service = createAdminService(env.DB, systemClock, access(), serviceBucket);
    expect(await service.addProductImage(jwt, { id, uploadId: crypto.randomUUID(), variants: imageVariants() })).toEqual({ ok: false, reason: "image_upload_failed" });
    expect(objects.size).toBe(0);
    expect(bucket.delete).toHaveBeenCalledTimes(1);
    expect(await app.getProductForAdmin(jwt, { id })).toMatchObject({ ok: true, data: { images: [] } });
  });

  it("D1 失敗會清理 R2，不刪除另一個同內容的成功上傳", async () => {
    const jwt = await mintAccessJwt();
    const id = await createProduct(jwt);
    const { serviceBucket, bucket, objects } = fakeBucket();
    const success = createAdminService(env.DB, systemClock, access(), serviceBucket);
    const failure = createAdminService(failInsert(), systemClock, access(), serviceBucket);
    const [saved, failed] = await Promise.all([success.addProductImage(jwt, { id, uploadId: crypto.randomUUID(), variants: imageVariants() }), failure.addProductImage(jwt, { id, uploadId: crypto.randomUUID(), variants: imageVariants() })]);
    expect(failed).toEqual({ ok: false, reason: "image_upload_failed" });
    expect(saved.ok).toBe(true);
    if (!saved.ok) throw new Error("upload failed");
    expect([...objects.keys()].sort()).toEqual(saved.data.image.variants.map((value) => value.key).sort());
    expect(bucket.delete).toHaveBeenCalledTimes(1);
    expect(await app.getProductForAdmin(jwt, { id })).toMatchObject({ ok: true, data: { images: [saved.data.image] } });
  });

  it("D1 已提交但回應遺失：查得成功記錄就保留物件並回成功", async () => {
    const jwt = await mintAccessJwt();
    const id = await createProduct(jwt);
    const { serviceBucket, bucket, objects } = fakeBucket();
    const d1 = { prepare: (sql: string) => {
      const statement = env.DB.prepare(sql);
      if (!sql.includes("INSERT INTO product_images")) return statement;
      return { bind: (...values: unknown[]) => ({ first: async () => {
        await statement.bind(...values).first();
        throw new Error("D1 response lost after commit");
      } }) };
    } } as unknown as D1Database;
    const result = await createAdminService(d1, systemClock, access(), serviceBucket).addProductImage(jwt, { id, uploadId: crypto.randomUUID(), variants: imageVariants() });
    expect(result.ok).toBe(true);
    expect(objects.size).toBe(3);
    expect(bucket.delete).not.toHaveBeenCalled();
    if (!result.ok) throw new Error("upload failed");
    expect(await app.getProductForAdmin(jwt, { id })).toMatchObject({ ok: true, data: { images: [result.data.image] } });
  });

  it("提交結果與後續查詢都失敗時保留物件，恢復後相同 uploadId 重試可取回", async () => {
    const jwt = await mintAccessJwt();
    const id = await createProduct(jwt);
    const { serviceBucket, bucket, objects } = fakeBucket();
    let committed = false;
    const d1 = { prepare: (sql: string) => {
      if (committed) throw new Error("D1 unavailable");
      const statement = env.DB.prepare(sql);
      if (!sql.includes("INSERT INTO product_images")) return statement;
      return { bind: (...values: unknown[]) => ({ first: async () => {
        await statement.bind(...values).first();
        committed = true;
        throw new Error("D1 response lost after commit");
      } }) };
    } } as unknown as D1Database;
    const input = { id, uploadId: crypto.randomUUID(), variants: imageVariants() };
    expect(await createAdminService(d1, systemClock, access(), serviceBucket).addProductImage(jwt, input)).toEqual({ ok: false, reason: "image_upload_failed" });
    expect(objects.size).toBe(3);
    expect(bucket.delete).not.toHaveBeenCalled();
    bucket.put.mockClear();
    const recovered = await createAdminService(env.DB, systemClock, access(), serviceBucket).addProductImage(jwt, input);
    expect(recovered.ok).toBe(true);
    expect(bucket.put).not.toHaveBeenCalled();
  });

  it("清理失敗仍回 image_upload_failed，不將底層錯誤傳給管理員", async () => {
    const jwt = await mintAccessJwt();
    const id = await createProduct(jwt);
    const { serviceBucket, bucket } = fakeBucket();
    bucket.delete.mockRejectedValue(new Error("R2 delete failed"));
    const service = createAdminService(failInsert(), systemClock, access(), serviceBucket);
    expect(await service.addProductImage(jwt, { id, uploadId: crypto.randomUUID(), variants: imageVariants() })).toEqual({ ok: false, reason: "image_upload_failed" });
    expect(await app.relistProduct(jwt, { id })).toEqual({ ok: false, reason: "no_images" });
  });

  it("D1 前置讀取失敗不會寫 R2，回 image_upload_failed", async () => {
    const jwt = await mintAccessJwt();
    const { serviceBucket, bucket } = fakeBucket();
    const db = { prepare: () => { throw new Error("D1 unavailable"); } } as unknown as D1Database;
    expect(await createAdminService(db, systemClock, access(), serviceBucket).addProductImage(jwt, { id: 1, uploadId: crypto.randomUUID(), variants: imageVariants() }))
      .toEqual({ ok: false, reason: "image_upload_failed" });
    expect(bucket.put).not.toHaveBeenCalled();
    expect(bucket.delete).not.toHaveBeenCalled();
  });

  it("沒有 R2 binding 時 fail closed", async () => {
    const jwt = await mintAccessJwt();
    const id = await createProduct(jwt);
    expect(await createAdminService(env.DB, systemClock, access()).addProductImage(jwt, { id, uploadId: crypto.randomUUID(), variants: imageVariants() }))
      .toEqual({ ok: false, reason: "image_upload_failed" });
  });
});
