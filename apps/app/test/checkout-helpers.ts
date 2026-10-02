import { exports } from "cloudflare:workers";
import { mintAccessJwt } from "./access";
import { uploadAndList } from "./images";

const app = exports.default;

/** 商品的預設變體編號（購物車、結帳與庫存都以變體為單位）。 */
export async function defaultVariantIdOf(productId: number): Promise<number> {
  const found = await app.getProductForAdmin(await mintAccessJwt(), { id: productId });
  if (!found.ok) throw new Error("讀取商品失敗");
  return found.data.defaultVariantId;
}

/** 新增一個上架中的商品並補足預設變體的在庫數，回傳商品與預設變體的 id；商品與庫存的行為由各自的測試驗證。 */
export async function createStockedListing(name: string, priceTwd: number, onHand: number, deliveryType?: "standard" | "large"): Promise<{ productId: number; variantId: number }> {
  const jwt = await mintAccessJwt();
  const created = await app.createProduct(jwt, { name, description: `${name}的說明`, priceTwd, deliveryType });
  if (!created.ok) throw new Error("新增商品失敗");
  const variantId = await defaultVariantIdOf(created.data.id);
  if (onHand > 0) await app.adjustStock(jwt, { variantId, delta: onHand });
  await uploadAndList(jwt, created.data.id);
  return { productId: created.data.id, variantId };
}

/** 同 `createStockedListing`，只回傳預設變體編號：多數測試只需要「買什麼」。 */
export async function createStockedVariant(name: string, priceTwd: number, onHand: number): Promise<number> {
  return (await createStockedListing(name, priceTwd, onHand)).variantId;
}

export const SHIPPING_INFO = { name: "王小明", phone: "0912345678", address: "台北市中正區重慶南路一段 122 號" };

let keyCounter = 0;
/** 每次呼叫都是新的、格式合法的冪等鍵。 */
export function newKey(): string {
  keyCounter += 1;
  return `test-key-${String(keyCounter).padStart(8, "0")}-abcdef`;
}

export interface LineInput {
  variantId: number;
  quantity: number;
  seenUnitPriceTwd: number;
}

/** 預設運費：測試商品都是一般宅配（預設費率 NT$100），顧客確認的運費合計就是 100；混合或調過費率的情境要明確傳入。 */
export const DEFAULT_SHIPPING_TWD = 100;

export function checkoutInput(lines: LineInput[], idempotencyKey = newKey(), seenShippingTwd = DEFAULT_SHIPPING_TWD) {
  return { lines, shippingInfo: SHIPPING_INFO, seenShippingTwd, idempotencyKey };
}
