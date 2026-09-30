import { z } from "zod";
import { wholeNumber } from "../shared/input";

/** 單張訂單的明細筆數上限；也讓一次結帳的語句數與綁定參數固定（D1 每次呼叫查詢數有上限）。 */
export const MAX_ORDER_LINES = 20;
/** 單筆明細的數量上限，與 Web 購物車的 `MAX_QUANTITY` 一致。 */
export const MAX_LINE_QUANTITY = 99;

// 上限：擋掉明顯的手誤與亂填，不是業務規則
const MAX_PRICE_TWD = 10_000_000;
const MAX_NAME_LENGTH = 100;
const MAX_PHONE_LENGTH = 30;
const MAX_ADDRESS_LENGTH = 300;

const productId = wholeNumber("商品編號").positive("商品編號無效");

const line = z.object({
  productId,
  quantity: wholeNumber("數量").min(1, "數量必須是 1 以上的整數").max(MAX_LINE_QUANTITY, `數量不可超過 ${MAX_LINE_QUANTITY}`),
  seenUnitPriceTwd: wholeNumber("單價").positive("單價必須大於 0").max(MAX_PRICE_TWD, `單價不可超過 ${MAX_PRICE_TWD}`),
});

const lines = z
  .array(line, { error: "訂單明細必須是清單" })
  .min(1, "訂單至少要有一筆明細")
  .max(MAX_ORDER_LINES, `訂單明細不可超過 ${MAX_ORDER_LINES} 筆`)
  .refine((items) => new Set(items.map((item) => item.productId)).size === items.length, "同一個商品不可重複出現");

const requiredText = (label: string, max: number) =>
  z
    .string({ error: `${label}必須是文字` })
    .trim()
    .min(1, `${label}不可為空`)
    .max(max, `${label}不可超過 ${max} 個字`);

/** 收件資訊（Shipping Info）；欄位錯誤都歸在 `shippingInfo` 底下，訊息自帶欄位名稱。 */
const shippingInfo = z.object({
  name: requiredText("收件人姓名", MAX_NAME_LENGTH),
  phone: requiredText("收件人電話", MAX_PHONE_LENGTH),
  address: requiredText("收件地址", MAX_ADDRESS_LENGTH),
});

/** 冪等鍵：由用戶端產生的不透明字串（例如 UUID），只接受安全字元，避免亂填。 */
const idempotencyKey = z.string({ error: "冪等鍵必須是文字" }).regex(/^[A-Za-z0-9_-]{16,64}$/, "冪等鍵格式無效");

export const checkoutInput = z.object({ lines, shippingInfo, idempotencyKey });
export type CheckoutInput = z.output<typeof checkoutInput>;
export type CheckoutLine = CheckoutInput["lines"][number];

export const orderIdInput = z.object({ orderId: wholeNumber("訂單編號").positive("訂單編號無效") });
