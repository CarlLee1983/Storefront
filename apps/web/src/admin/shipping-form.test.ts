import { describe, expect, it } from "vitest";
import { shippingRateFormToInput } from "./shipping-form";

describe("shippingRateFormToInput", () => {
  it("取出配送類型與金額", () => {
    const form = new FormData();
    form.set("deliveryType", "large");
    form.set("feeTwd", "650");
    expect(shippingRateFormToInput(form)).toEqual({ deliveryType: "large", feeTwd: 650 });
  });

  it("金額留白轉成 NaN，由 App 回報錯誤", () => {
    const form = new FormData();
    form.set("deliveryType", "standard");
    form.set("feeTwd", " ");
    expect(shippingRateFormToInput(form).feeTwd).toBeNaN();
  });
});
