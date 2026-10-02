import type { AdminVariant } from "@storefront/app/catalog-types";
import { describe, expect, it } from "vitest";
import { summarizeVariants } from "./variant-summary";

const variant = (priceTwd: number, onHand: number, reserved: number, overrides: Partial<AdminVariant> = {}): AdminVariant => ({
  id: priceTwd, isDefault: false, optionValues: [], priceTwd, compareAtPriceTwd: null, onHand, reserved, available: onHand - reserved, discontinued: false, imageId: null, ...overrides,
});

describe("summarizeVariants", () => {
  it("單一變體就是它自己", () => {
    expect(summarizeVariants({ variants: [variant(320, 5, 2)] })).toEqual({ multiple: false, minPriceTwd: 320, maxPriceTwd: 320, onHand: 5, reserved: 2, available: 3 });
  });

  it("多個變體：價格取範圍、庫存加總，停賣的變體庫存仍算", () => {
    expect(summarizeVariants({ variants: [variant(9000, 3, 1), variant(12000, 2, 0), variant(8000, 4, 0, { discontinued: true })] }))
      .toEqual({ multiple: true, minPriceTwd: 8000, maxPriceTwd: 12000, onHand: 9, reserved: 1, available: 8 });
  });
});
