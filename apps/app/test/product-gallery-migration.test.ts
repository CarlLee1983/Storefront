import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { createAdminService } from "../src/admin/service";
import { systemClock } from "../src/shared/clock";
import { mintAccessJwt } from "./access";
import { imageVariants } from "./images";

it("0007→0008 preserves full galleries, image keys and upload identities while enabling reorder", async () => {
  const d1 = env.MIGRATION_DB;
  await applyD1Migrations(d1, env.TEST_MIGRATIONS.slice(0, 8));
  const service = createAdminService(d1, systemClock, { teamDomain: env.ACCESS_TEAM_DOMAIN, audience: env.ACCESS_AUD, jwksJson: env.ACCESS_JWKS_JSON }, env.PRODUCT_IMAGES);
  const jwt = await mintAccessJwt();
  // 0008 還沒有分類欄位，現行的 App 程式碼寫不進這個舊結構，所以商品以 SQL 直接安排
  const created = await d1.prepare("INSERT INTO products (name, description, price_twd, on_hand) VALUES ('既有完整圖庫', '保留', 200, 5) RETURNING id").first<{ id: number }>();
  const id = created!.id;
  const uploads = [];
  for (let n = 0; n < 8; n++) {
    const input = { id, uploadId: crypto.randomUUID(), variants: imageVariants() };
    const result = await service.addProductImage(jwt, input);
    if (!result.ok) throw new Error("upload");
    uploads.push({ input, result });
  }
  await d1.prepare("UPDATE products SET listed = 1 WHERE id = ?").bind(id).run();
  const images = uploads.map((upload) => upload.result.data.image);
  // 遷移前的完整快照（現行程式碼讀不了 0008 的結構，所以從資料列組出同一個形狀）
  const row = await d1.prepare("SELECT name, description, price_twd, on_hand FROM products WHERE id = ?").bind(id)
    .first<{ name: string; description: string; price_twd: number; on_hand: number }>();
  const before = {
    ok: true,
    data: {
      id, name: row!.name, description: row!.description, defaultVariantId: expect.any(Number), priceTwd: row!.price_twd, compareAtPriceTwd: null,
      onHand: row!.on_hand, reserved: 0, available: row!.on_hand,
      cover: images[0], images, listed: true, featured: false, category: null,
    },
  };
  await applyD1Migrations(d1, env.TEST_MIGRATIONS);
  // 0009 讓沒有分類的上架商品下架，其餘（封面、圖庫、庫存、內容）完全不變
  expect(await service.getProductForAdmin(jwt, { id })).toEqual({ ...before, data: { ...before.data, listed: false, category: null } });
  for (const upload of uploads) expect(await service.addProductImage(jwt, upload.input)).toEqual(upload.result);
  expect((await d1.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  expect((await service.reorderProductImages(jwt, { id, imageIds: [...uploads].reverse().map(upload => upload.result.data.image.id) })).ok).toBe(true);
  for (const upload of uploads) for (const variant of upload.result.data.image.variants) expect(await env.PRODUCT_IMAGES.get(variant.key)).not.toBeNull();
});
