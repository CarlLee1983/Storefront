import { computeShippingFees, DELIVERY_TYPES, type DeliveryType, type ShippingFees, type ShippingRates } from "@storefront/app/shipping-types";
import type { Cart } from "../cart/cart";

/** 試算運費 API 回傳的內容（App 的 `getShippingQuote`）：現行費率與購物車各變體的配送類型。 */
export interface ShippingQuote {
  rates: ShippingRates;
  variants: { variantId: number; deliveryType: DeliveryType }[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isFee = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isDeliveryType = (value: unknown): value is DeliveryType => DELIVERY_TYPES.some((type) => type === value);

/** 解析 `/api/shipping-quote` 的回應；形狀不符回 null（結帳頁據此停用送出，不拿不確定的運費下單）。 */
export function parseShippingQuote(raw: unknown): ShippingQuote | null {
  if (!isRecord(raw) || !isRecord(raw.rates) || !Array.isArray(raw.variants)) return null;
  const { standard, large } = raw.rates;
  if (!isFee(standard) || !isFee(large)) return null;
  const variants: ShippingQuote["variants"] = [];
  for (const item of raw.variants) {
    if (!isRecord(item) || typeof item.variantId !== "number" || !isDeliveryType(item.deliveryType)) return null;
    variants.push({ variantId: item.variantId, deliveryType: item.deliveryType });
  }
  return { rates: { standard, large }, variants };
}

/** 試算 API 的查詢網址：帶購物車所有變體編號（空購物車不需要查）。 */
export function shippingQuoteUrl(cart: Cart): string {
  return `/api/shipping-quote?variants=${cart.lines.map((line) => line.variantId).join(",")}`;
}

/** 購物車的運費：與 App 下單時同一條規則（含該類型就收一次），查不到的變體不計（下單時 App 會另外拒絕）。 */
export function cartShippingFees(cart: Cart, quote: ShippingQuote): ShippingFees {
  const typeOf = new Map(quote.variants.map((variant) => [variant.variantId, variant.deliveryType]));
  const types = cart.lines.flatMap((line) => typeOf.get(line.variantId) ?? []);
  return computeShippingFees(types, quote.rates);
}
