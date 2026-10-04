import { env, exports } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import { resetDb } from "./db";
import { createStockedListing, checkoutInput } from "./checkout-helpers";
import { signInCustomer } from "./customers";
import { mintAccessJwt } from "./access";

const app = exports.default;
beforeEach(resetDb);

it("public availability uses the same live reservations/unavailable stock and only returns public fields", async () => {
  const { variantId } = await createStockedListing("可售花器", 680, 4);
  expect(await app.getAvailability({ variantIds: [variantId] })).toEqual({ ok: true, data: { variants: [{ variantId, available: 4 }] } });
  const cookie = await signInCustomer("availability");
  expect((await app.checkout(cookie, checkoutInput([{ variantId, quantity: 2, seenUnitPriceTwd: 680 }]))).ok).toBe(true);
  await env.DB.prepare("UPDATE product_variants SET unavailable = 1 WHERE id = ?").bind(variantId).run();
  expect(await app.getAvailability({ variantIds: [variantId, variantId] })).toEqual({ ok: true, data: { variants: [{ variantId, available: 1 }] } });
  expect((await app.checkout(cookie, checkoutInput([{ variantId, quantity: 2, seenUnitPriceTwd: 680 }]))).ok).toBe(false);
});

it("zero remains a valid variant; unlisted/discontinued/missing variants are omitted", async () => {
  const a = await createStockedListing("售完", 100, 0);
  const b = await createStockedListing("下架", 100, 4);
  const c = await createStockedListing("停賣", 100, 4);
  await app.unlistProduct(await mintAccessJwt(), { id: b.productId });
  await env.DB.prepare("UPDATE product_variants SET discontinued_at = 1 WHERE id = ?").bind(c.variantId).run();
  expect(await app.getAvailability({ variantIds: [a.variantId, b.variantId, c.variantId, 999999] })).toEqual({ ok: true, data: { variants: [{ variantId: a.variantId, available: 0 }] } });
  expect(await app.getAvailability({ variantIds: [] })).toEqual({ ok: true, data: { variants: [] } });
});

it.each([null, {}, { variantIds: "1" }, { variantIds: [0] }, { variantIds: [-1] }, { variantIds: [1.5] }, { variantIds: [Number.MAX_SAFE_INTEGER + 1] }, { variantIds: Array.from({ length: 21 }, (_, i) => i + 1) }])("rejects malformed or unbounded input %j", async input => {
  expect(await app.getAvailability(input)).toMatchObject({ ok: false, reason: "invalid_input" });
});
