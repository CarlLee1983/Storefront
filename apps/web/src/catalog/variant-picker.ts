import type { VariantDetail } from "@storefront/app/catalog-types";

/** 每個選項維度目前選的值；沒有選項的商品為空陣列。 */
export type Selection = readonly string[];

const isPurchasable = (variant: VariantDetail) => variant.available > 0;

/** 初始選取：第一個可購買的變體（呼叫端傳入的順序是預設變體在前），都售完就選第一個；沒有變體為 null。 */
export function initialVariant(variants: readonly VariantDetail[]): VariantDetail | null {
  return variants.find(isPurchasable) ?? variants[0] ?? null;
}

/** 選取的選項值剛好對應的變體；那組選項沒有販售（或已停賣）時為 undefined。 */
export function findVariant(variants: readonly VariantDetail[], selection: Selection): VariantDetail | undefined {
  return variants.find((variant) => variant.optionValues.every((value, index) => value === selection[index]));
}

/**
 * 在某個維度改選一個值。只建立實際販售的組合，所以其他維度保持原選擇時若沒有對應變體，
 * 就改選含此值的第一個可購買變體（沒有可購買的就取第一個）的其他維度——選取結果一定對應到一個變體。
 */
export function selectOption(variants: readonly VariantDetail[], selection: Selection, dimension: number, value: string): Selection {
  const next = selection.map((current, index) => (index === dimension ? value : current));
  if (findVariant(variants, next)) return next;
  const candidates = variants.filter((variant) => variant.optionValues[dimension] === value);
  return (candidates.find(isPurchasable) ?? candidates[0])?.optionValues ?? selection;
}

export interface OptionChoice {
  value: string;
  selected: boolean;
  /** 含此值的變體都已售完（仍可選，讓顧客看到「售完」）。 */
  soldOut: boolean;
}

/** 某個維度的所有選項值（依出現順序去重）與各自狀態，給畫面畫選項按鈕。 */
export function optionChoices(variants: readonly VariantDetail[], selection: Selection, dimension: number): OptionChoice[] {
  const values = [...new Set(variants.map((variant) => variant.optionValues[dimension]!))];
  return values.map((value) => ({
    value,
    selected: selection[dimension] === value,
    soldOut: !variants.some((variant) => variant.optionValues[dimension] === value && isPurchasable(variant)),
  }));
}

/** 可售量文字：現貨充足、低庫存（5 件以內）與售完。 */
export function describeAvailability(available: number): string {
  if (available <= 0) return "已售完";
  return available <= 5 ? `僅剩 ${available} 件現貨` : `現貨，可售 ${available} 件`;
}

/** 加入購物車的選項標籤（與訂單明細的快照格式一致）：選項值以「 / 」相連。 */
export function variantLabel(variant: Pick<VariantDetail, "optionValues">): string {
  return variant.optionValues.join(" / ");
}
