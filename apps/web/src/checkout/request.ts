import type { Cart } from "../cart/cart";
import { toText } from "../shared/form-values";

/** 購物車 → 結帳明細：只帶商品變體、數量與加入時看到的單價（App 拿它與最新單價比對）。 */
export function cartToCheckoutLines(cart: Cart) {
  return cart.lines.map((line) => ({
    variantId: line.variantId,
    quantity: line.quantity,
    seenUnitPriceTwd: line.unitPriceTwd,
  }));
}

/** 明細欄位是 client script 放進表單的 JSON；解析不了就是 null，由 App 的驗證回報輸入有誤。 */
function parseLines(raw: unknown): unknown {
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** 結帳表單 → RPC 輸入；不判斷內容是否合法，由 App 驗證。 */
export function checkoutFormToInput(form: FormData) {
  return {
    lines: parseLines(form.get("lines")),
    shippingInfo: {
      name: toText(form.get("name")),
      phone: toText(form.get("phone")),
      address: toText(form.get("address")),
    },
    idempotencyKey: toText(form.get("idempotencyKey")),
  };
}

/**
 * 這一次結帳的內容指紋（明細與收件資訊；收件資訊 trim，與 App 一致）：內容變了就要換一把冪等鍵，
 * 因為 App 對「同一個鍵、不同內容」回 `idempotency_key_reused`。
 */
export function checkoutFingerprint(
  lines: ReturnType<typeof cartToCheckoutLines>,
  shipping: { name: string; phone: string; address: string },
): string {
  return JSON.stringify({
    lines: lines.map((line) => [line.variantId, line.quantity, line.seenUnitPriceTwd]),
    shipping: [shipping.name.trim(), shipping.phone.trim(), shipping.address.trim()],
  });
}
