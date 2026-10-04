/** 配送類型（Delivery Type）：一般宅配與可預約的大型配送，範圍限台灣本島。存英文代碼，顯示名稱在 `DELIVERY_TYPE_LABELS`。 */
export const DELIVERY_TYPES = ["standard", "large"] as const;
export type DeliveryType = (typeof DELIVERY_TYPES)[number];

export const DELIVERY_TYPE_LABELS: Record<DeliveryType, string> = { standard: "一般宅配", large: "大型配送" };

/** 各配送類型的現行費率，新台幣整數元。 */
export type ShippingRates = Record<DeliveryType, number>;

/** 一張訂單各類型實收運費與合計；沒有該類型的明細時為 0。 */
export interface ShippingFees extends ShippingRates {
  totalTwd: number;
}

/** 運費：明細含某類型就收該類型費率一次（混合各收一次），同類不按件數、不按明細數計費。 */
export function computeShippingFees(types: Iterable<DeliveryType>, rates: ShippingRates): ShippingFees {
  const present = new Set(types);
  const standard = present.has("standard") ? rates.standard : 0;
  const large = present.has("large") ? rates.large : 0;
  return { standard, large, totalTwd: standard + large };
}
