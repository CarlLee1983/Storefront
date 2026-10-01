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
  const created = await service.createProduct(jwt, { name: "既有完整圖庫", description: "保留", priceTwd: 200 });
  if (!created.ok) throw new Error("create");
  const id = created.data.id;
  const uploads = [];
  for (let n = 0; n < 8; n++) {
    const input = { id, uploadId: crypto.randomUUID(), variants: imageVariants() };
    const result = await service.addProductImage(jwt, input);
    if (!result.ok) throw new Error("upload");
    uploads.push({ input, result });
  }
  await service.relistProduct(jwt, { id });
  const before = await service.getProductForAdmin(jwt, { id });
  await applyD1Migrations(d1, env.TEST_MIGRATIONS);
  expect(await service.getProductForAdmin(jwt, { id })).toEqual(before);
  for (const upload of uploads) expect(await service.addProductImage(jwt, upload.input)).toEqual(upload.result);
  expect((await d1.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  expect((await service.reorderProductImages(jwt, { id, imageIds: [...uploads].reverse().map(upload => upload.result.data.image.id) })).ok).toBe(true);
  for (const upload of uploads) for (const variant of upload.result.data.image.variants) expect(await env.PRODUCT_IMAGES.get(variant.key)).not.toBeNull();
});
