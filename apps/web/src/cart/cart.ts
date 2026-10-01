import { parseCartCover, type CartCover } from "./cover";

/** 單筆數量上限；超過時夾到上限（不拒絕），避免顧客連按或手誤而失去整次加入。 */
export const MAX_QUANTITY = 99;

/** 目前的序列化格式版本；格式變動時遞增，舊版內容視為空購物車。 */
export const CART_VERSION = 1;

export interface CartItem {
  productId: number;
  /** 加入當下看到的商品名稱。 */
  name: string;
  /** 加入當下看到的單價，新台幣正整數元；結帳時用來與最新單價比對。 */
  unitPriceTwd: number;
  /** 加入當下的封面；舊購物車可能沒有。 */
  cover?: CartCover;
}

export interface CartLine extends CartItem {
  quantity: number;
}

export interface Cart {
  version: typeof CART_VERSION;
  lines: readonly CartLine[];
}

export const emptyCart: Cart = Object.freeze({ version: CART_VERSION, lines: Object.freeze([]) });

function isPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1;
}

/** 數量是否為可加入購物車的正整數（是否超過上限另由夾值處理）。 */
export const isValidQuantity = isPositiveInteger;

/** 商品資料合格：編號與單價都是正的 safe integer（App 規定售價為正整數元）。 */
function isValidItem(item: CartItem): boolean {
  return isPositiveInteger(item.productId) && isPositiveInteger(item.unitPriceTwd);
}

/** 夾在 1 到 MAX_QUANTITY 之間；加入與改數量時數量已驗證為正整數，下限是給加減按鈕用的。 */
export function clampQuantity(quantity: number): number {
  return Math.min(Math.max(quantity, 1), MAX_QUANTITY);
}

/**
 * 加入購物車。同一商品已在車內時合併成同一筆：數量相加，
 * 名稱與單價以最新這次加入時看到的為準（覆蓋舊值），筆的位置不變。
 * 商品資料不合格或數量不是正整數就拒絕（回傳原購物車）；合併後超過 MAX_QUANTITY 夾到上限。
 */
export function addToCart(cart: Cart, item: CartItem, quantity: number): Cart {
  if (!isPositiveInteger(quantity) || !isValidItem(item)) return cart;
  const existing = cart.lines.find((line) => line.productId === item.productId);
  if (!existing) return { ...cart, lines: [...cart.lines, { ...item, quantity: clampQuantity(quantity) }] };
  return {
    ...cart,
    lines: cart.lines.map((line) =>
      line === existing ? { ...item, quantity: clampQuantity(existing.quantity + quantity) } : line,
    ),
  };
}

/** 改數量：數量不是正整數或車內沒有該商品就回傳原購物車；超過上限夾到上限。移除請用 removeFromCart。 */
export function setQuantity(cart: Cart, productId: number, quantity: number): Cart {
  if (!isPositiveInteger(quantity) || !cart.lines.some((line) => line.productId === productId)) return cart;
  return {
    ...cart,
    lines: cart.lines.map((line) =>
      line.productId === productId ? { ...line, quantity: clampQuantity(quantity) } : line,
    ),
  };
}

export function removeFromCart(cart: Cart, productId: number): Cart {
  return { ...cart, lines: cart.lines.filter((line) => line.productId !== productId) };
}

/** 小計，新台幣整數元（單價為整數元，乘上整數數量仍是整數）。 */
export function lineSubtotal(line: CartLine): number {
  return line.unitPriceTwd * line.quantity;
}

/** 總額，新台幣整數元、含稅、免運。 */
export function cartTotal(cart: Cart): number {
  return cart.lines.reduce((sum, line) => sum + lineSubtotal(line), 0);
}

/** 件數：各筆數量加總（不是筆數）。 */
export function cartCount(cart: Cart): number {
  return cart.lines.reduce((sum, line) => sum + line.quantity, 0);
}

export function serializeCart(cart: Cart): string {
  return JSON.stringify(cart);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function parseLine(value: unknown): CartLine | null {
  if (!isRecord(value)) return null;
  const { productId, name, unitPriceTwd, quantity } = value;
  if (typeof productId !== "number" || !isPositiveInteger(productId)) return null;
  if (typeof name !== "string") return null;
  if (typeof unitPriceTwd !== "number" || !isPositiveInteger(unitPriceTwd)) return null;
  if (typeof quantity !== "number" || !isPositiveInteger(quantity) || quantity > MAX_QUANTITY) return null;
  const cover = parseCartCover(value.cover);
  return { productId, name, unitPriceTwd, quantity, ...(cover ? { cover } : {}) };
}

/**
 * 還原序列化內容。localStorage 的內容不可信：不是 JSON、版本不符、形狀不對、
 * 任一筆不合法或同一商品重複，整份都視為空購物車（不部分採信），頁面不會壞。
 */
export function deserializeCart(raw: string | null): Cart {
  if (raw === null) return emptyCart;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return emptyCart;
  }
  if (!isRecord(data) || data.version !== CART_VERSION || !Array.isArray(data.lines)) return emptyCart;
  const lines = data.lines.map(parseLine);
  const valid = lines.filter((line): line is CartLine => line !== null);
  const ids = new Set(valid.map((line) => line.productId));
  if (valid.length !== lines.length || ids.size !== valid.length) return emptyCart;
  return { version: CART_VERSION, lines: valid };
}
