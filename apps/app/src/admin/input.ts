import { z } from "zod";
import { categoryId } from "../categories/input";
import { orderIdInput } from "../orders/input";
import { ORDER_STATUSES } from "../orders/schema";
import { wholeNumber } from "../shared/input";

// 上限：擋掉明顯的手誤與亂填（超長文字、離譜的價格），不是業務規則
const MAX_NAME_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_PRICE_TWD = 10_000_000;
const MAX_STOCK_DELTA = 1_000_000;

const productId = wholeNumber("商品編號").positive("商品編號無效");
const variantId = wholeNumber("商品變體編號").positive("商品變體編號無效");

const name = z
  .string({ error: "名稱必須是文字" })
  .trim()
  .min(1, "名稱不可為空")
  .max(MAX_NAME_LENGTH, `名稱不可超過 ${MAX_NAME_LENGTH} 個字`);

/** 純文字說明，可以留空。 */
const description = z
  .string({ error: "說明必須是文字" })
  .trim()
  .max(MAX_DESCRIPTION_LENGTH, `說明不可超過 ${MAX_DESCRIPTION_LENGTH} 個字`);

/** 單價：新台幣整數元，正整數。 */
const priceTwd = wholeNumber("單價")
  .positive("單價必須大於 0")
  .max(MAX_PRICE_TWD, `單價不可超過 ${MAX_PRICE_TWD}`);

/** 原價：同樣是新台幣整數元的正整數；是否高於售價由 service 以儲存後的結果檢查。 */
const compareAtPriceTwd = wholeNumber("原價")
  .positive("原價必須大於 0")
  .max(MAX_PRICE_TWD, `原價不可超過 ${MAX_PRICE_TWD}`);

export const createProductInput = z.object({ name, description, priceTwd });

/**
 * 修改商品；`categoryId` 不帶表示不動分類，帶 `null` 表示清成沒有分類
 *（上架中的商品不允許，由 service 檢查）。`compareAtPriceTwd` 不帶表示不動原價，帶 `null` 表示清空（結束特價）。
 */
export const updateProductInput = z.object({ id: productId, name, description, priceTwd, compareAtPriceTwd: compareAtPriceTwd.nullable().optional(), categoryId: categoryId.nullable().optional() });
export const productIdInput = z.object({ id: productId });
export const setProductFeaturedInput = z.object({ id: productId, featured: z.boolean({ error: "精選必須是布林值" }) });

/** 庫存調整的增減量（作用在變體上）：非零整數（+20 補貨、-3 盤損）；沒有「設成某個數字」的輸入。 */
const stockDelta = wholeNumber("增減量")
  .refine((value) => value !== 0, "增減量不可為 0")
  .min(-MAX_STOCK_DELTA, `增減量不可小於 -${MAX_STOCK_DELTA}`)
  .max(MAX_STOCK_DELTA, `增減量不可超過 ${MAX_STOCK_DELTA}`);

export const adjustStockInput = z.object({ variantId, delta: stockDelta });

const MAX_TRACKING_NUMBER_LENGTH = 100;

/** 物流單號：選填；trim 後是空字串就視為沒有（存 null）。 */
const trackingNumber = z
  .string({ error: "物流單號必須是文字" })
  .trim()
  .max(MAX_TRACKING_NUMBER_LENGTH, `物流單號不可超過 ${MAX_TRACKING_NUMBER_LENGTH} 個字`)
  // 只收可列印 ASCII（含空格）：擋掉換行與控制字元，物流單號本來就只有英數與符號
  .regex(/^[\x20-\x7E]*$/, "物流單號只能包含英數字與一般符號")
  .transform((value) => (value === "" ? null : value))
  .optional()
  .transform((value) => value ?? null);

export const shipOrderInput = z.object({ orderId: orderIdInput.shape.orderId, trackingNumber });

export const listOrdersInput = z.object({ status: z.enum(ORDER_STATUSES, { error: "訂單狀態無效" }).optional() });
