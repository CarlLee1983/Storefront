import { describe, expect, it } from "vitest";
import { addToCart, deserializeCart, emptyCart, serializeCart, setQuantity } from "./cart";
import { parseCartCover } from "./cover";

const key = `products/1/00000000-0000-4000-8000-000000000001/${"a".repeat(64)}.webp`;
const cover = { variants: [{ key, width: 320, height: 240 }] };
const item = { productId: 1, name: "馬克杯", unitPriceTwd: 320 };

describe("add-time cover snapshot", () => {
  it("persists the cover with price, preserves it on quantity changes and replaces it on the next add", () => {
    const first = addToCart(emptyCart, { ...item, cover }, 1);
    expect(deserializeCart(serializeCart(first)).lines[0]?.cover).toEqual(cover);
    expect(setQuantity(first, 1, 3).lines[0]?.cover).toEqual(cover);
    const next = { variants: [{ key: key.replace(/a{64}/, "b".repeat(64)), width: 320, height: 240 }] };
    expect(addToCart(first, { ...item, cover: next, unitPriceTwd: 400 }, 1).lines[0]).toMatchObject({ cover: next, unitPriceTwd: 400, quantity: 2 });
  });
  it("keeps legacy carts and invalid optional images usable", () => {
    const legacy = addToCart(emptyCart, item, 2);
    expect(deserializeCart(serializeCart(legacy))).toEqual(legacy);
    const raw = JSON.stringify({ ...legacy, lines: [{ ...legacy.lines[0], cover: { variants: [{ key: "https://third-party.test/image", width: 320, height: 240 }] } }] });
    expect(deserializeCart(raw)).toEqual(legacy);
  });
  it.each([null, "bad", {}, { variants: [] }, { variants: [null] }, { variants: ["bad"] }, { variants: Array(4).fill(cover.variants[0]) }, { variants: Array(2).fill(cover.variants[0]) }, { variants: [{ key, width: 500, height: 240 }] }, { variants: [{ key, width: 320, height: 0 }] }, { variants: [{ key, width: 320, height: 9000 }] }, { variants: [{ key, width: 320, height: 1.5 }] }])("ignores an invalid optional cover: %j", value => {
    expect(parseCartCover(value)).toBeUndefined();
  });
  it("keeps only validated fields and orders sizes for srcset", () => {
    expect(parseCartCover({ id: "ignored", variants: [{ key, width: 640, height: 480 }, { key, width: 320, height: 240 }] })).toEqual({ variants: [{ key, width: 320, height: 240 }, { key, width: 640, height: 480 }] });
  });
});
