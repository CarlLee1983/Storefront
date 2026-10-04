import { parseCartCover, type CartCover } from "./cover";

import { MAX_LINE_QUANTITY } from "@storefront/app/order-limits";

/** 單筆數量上限；超過時整次拒絕。 */
export const MAX_QUANTITY = MAX_LINE_QUANTITY;

/** 目前的序列化格式版本；格式變動時遞增，舊版內容視為空購物車。2：購物車改以商品變體為單位。 */
export const CART_VERSION = 2;

export interface CartItem {
  /** 販售單位：結帳、價格校驗與庫存都以商品變體為準，購物車也以它判斷是不是同一筆。 */
  variantId: number;
  /** 所屬商品，只用來連回商品頁。 */
  productId: number;
  /** 加入當下看到的商品名稱。 */
  name: string;
  /** 加入當下選的變體選項（例如「120 公分 / 胡桃色」），只用來顯示；沒有選項的商品省略。 */
  label?: string;
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

/** 數量是否為可加入購物車的正整數（上限另由購買判斷處理）。 */
export const isValidQuantity = isPositiveInteger;

/** 商品資料合格：編號與單價都是正的 safe integer（App 規定售價為正整數元）。 */
function isValidItem(item: CartItem): boolean {
  return isPositiveInteger(item.variantId) && isPositiveInteger(item.productId) && isPositiveInteger(item.unitPriceTwd);
}

/**
 * 加入購物車。同一商品變體已在車內時合併成同一筆：數量相加，
 * 名稱與單價以最新這次加入時看到的為準（覆蓋舊值），筆的位置不變。
 * 商品資料不合格或數量不是正整數就拒絕（回傳原購物車）；合併後超過可售數量或 MAX_QUANTITY 時整次拒絕。
 */
export function addToCart(cart: Cart, item: CartItem, quantity: number, available = MAX_QUANTITY): Cart {
  if (!Number.isSafeInteger(available) || available < 0 || !isPositiveInteger(quantity) || !isValidItem(item)) return cart;
  const existing = cart.lines.find((line) => line.variantId === item.variantId);
  if (quantity > Math.min(available, MAX_QUANTITY) - (existing?.quantity ?? 0)) return cart;
  if (!existing) return { ...cart, lines: [...cart.lines, { ...item, quantity }] };
  return {
    ...cart,
    lines: cart.lines.map((line) =>
      line === existing ? { ...item, quantity: existing.quantity + quantity } : line,
    ),
  };
}

/** 改數量：數量不是正整數或車內沒有該商品變體就回傳原購物車；超過上限拒絕。移除請用 removeFromCart。 */
export function setQuantity(cart: Cart, variantId: number, quantity: number): Cart {
  if (!isPositiveInteger(quantity) || quantity > MAX_QUANTITY || !cart.lines.some((line) => line.variantId === variantId)) return cart;
  return {
    ...cart,
    lines: cart.lines.map((line) =>
      line.variantId === variantId ? { ...line, quantity } : line,
    ),
  };
}

export function removeFromCart(cart: Cart, variantId: number): Cart {
  return { ...cart, lines: cart.lines.filter((line) => line.variantId !== variantId) };
}

/** 小計，新台幣整數元（單價為整數元，乘上整數數量仍是整數）。 */
export function lineSubtotal(line: CartLine): number {
  return line.unitPriceTwd * line.quantity;
}

/** 商品合計，新台幣整數元、含稅、未含運費（運費依配送類型，於結帳時由 App 試算）。 */
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
  const { variantId, productId, name, label, unitPriceTwd, quantity } = value;
  if (typeof variantId !== "number" || !isPositiveInteger(variantId)) return null;
  if (typeof productId !== "number" || !isPositiveInteger(productId)) return null;
  if (typeof name !== "string") return null;
  if (label !== undefined && typeof label !== "string") return null;
  if (typeof unitPriceTwd !== "number" || !isPositiveInteger(unitPriceTwd)) return null;
  if (typeof quantity !== "number" || !isPositiveInteger(quantity) || quantity > MAX_QUANTITY) return null;
  const cover = parseCartCover(value.cover);
  return { variantId, productId, name, ...(label ? { label } : {}), unitPriceTwd, quantity, ...(cover ? { cover } : {}) };
}

/**
 * 還原序列化內容。localStorage 的內容不可信：不是 JSON、版本不符、形狀不對、
 * 任一筆不合法或同一商品變體重複，整份都視為空購物車（不部分採信），頁面不會壞。
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
  const ids = new Set(valid.map((line) => line.variantId));
  if (valid.length !== lines.length || ids.size !== valid.length) return emptyCart;
  return { version: CART_VERSION, lines: valid };
}
