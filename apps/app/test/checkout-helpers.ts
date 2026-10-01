import { exports } from "cloudflare:workers";
import { mintAccessJwt } from "./access";
import { uploadAndList } from "./images";

const app = exports.default;

/** 新增一個上架中的商品並補足在庫數，回傳它的 id；商品與庫存的行為由各自的測試驗證。 */
export async function createStockedProduct(name: string, priceTwd: number, onHand: number): Promise<number> {
  const jwt = await mintAccessJwt();
  const created = await app.createProduct(jwt, { name, description: `${name}的說明`, priceTwd });
  if (!created.ok) throw new Error("新增商品失敗");
  if (onHand > 0) await app.adjustStock(jwt, { id: created.data.id, delta: onHand });
  await uploadAndList(jwt, created.data.id);
  return created.data.id;
}

export const SHIPPING_INFO = { name: "王小明", phone: "0912345678", address: "台北市中正區重慶南路一段 122 號" };

let keyCounter = 0;
/** 每次呼叫都是新的、格式合法的冪等鍵。 */
export function newKey(): string {
  keyCounter += 1;
  return `test-key-${String(keyCounter).padStart(8, "0")}-abcdef`;
}

export interface LineInput {
  productId: number;
  quantity: number;
  seenUnitPriceTwd: number;
}

export function checkoutInput(lines: LineInput[], idempotencyKey = newKey()) {
  return { lines, shippingInfo: SHIPPING_INFO, idempotencyKey };
}
