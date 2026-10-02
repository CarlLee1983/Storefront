import { exports } from "cloudflare:workers";
import { mintAccessJwt } from "./access";
import { defaultVariantIdOf } from "./checkout-helpers";
import { uploadAndList } from "./images";

const app = exports.default;

export interface OptionVariantSpec {
  values: string[];
  priceTwd: number;
  compareAtPriceTwd?: number;
  onHand: number;
  discontinued?: boolean;
}

/**
 * 建立一個上架中、有選項維度的商品：預設變體取第一組規格，其餘規格逐一新增，各自補足在庫數。
 * 回傳商品編號與各規格的變體編號（順序同輸入）；選項與變體管理的行為由 product-variant-options.test.ts 驗證。
 */
export async function createOptionListing(name: string, optionNames: string[], specs: OptionVariantSpec[]): Promise<{ productId: number; variantIds: number[]; imageId: string }> {
  const jwt = await mintAccessJwt();
  const [first, ...rest] = specs;
  const created = await app.createProduct(jwt, { name, description: `${name}的說明`, priceTwd: first!.priceTwd });
  if (!created.ok) throw new Error("新增商品失敗");
  const productId = created.data.id;
  const defaultId = await defaultVariantIdOf(productId);
  const optioned = await app.setProductOptions(jwt, { id: productId, optionNames, defaultVariantValues: first!.values });
  if (!optioned.ok) throw new Error(`設定選項失敗：${optioned.reason}`);
  const variantIds = [defaultId];
  for (const spec of rest) {
    const variant = await app.createVariant(jwt, { productId, optionValues: spec.values, priceTwd: spec.priceTwd, compareAtPriceTwd: spec.compareAtPriceTwd });
    if (!variant.ok) throw new Error(`新增變體失敗：${variant.reason}`);
    variantIds.push(variant.data.id);
  }
  if (first!.compareAtPriceTwd !== undefined) {
    await app.updateVariant(jwt, { variantId: defaultId, optionValues: first!.values, priceTwd: first!.priceTwd, compareAtPriceTwd: first!.compareAtPriceTwd });
  }
  for (const [index, spec] of specs.entries()) {
    if (spec.onHand > 0) await app.adjustStock(jwt, { variantId: variantIds[index]!, delta: spec.onHand });
    if (spec.discontinued) await app.setVariantDiscontinued(jwt, { variantId: variantIds[index]!, discontinued: true });
  }
  const image = await uploadAndList(jwt, productId);
  return { productId, variantIds, imageId: image.id };
}
