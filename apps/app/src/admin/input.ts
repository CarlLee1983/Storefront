import { z } from "zod";
import { wholeNumber } from "../shared/input";

// 上限：擋掉明顯的手誤與亂填（超長文字、離譜的價格），不是業務規則
const MAX_NAME_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_PRICE_TWD = 10_000_000;
const MAX_STOCK_DELTA = 1_000_000;

const productId = wholeNumber("商品編號").positive("商品編號無效");

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

export const createProductInput = z.object({ name, description, priceTwd });

export const updateProductInput = z.object({ id: productId, name, description, priceTwd });
export const productIdInput = z.object({ id: productId });

/** 庫存調整的增減量：非零整數（+20 補貨、-3 盤損）；沒有「設成某個數字」的輸入。 */
const stockDelta = wholeNumber("增減量")
  .refine((value) => value !== 0, "增減量不可為 0")
  .min(-MAX_STOCK_DELTA, `增減量不可小於 -${MAX_STOCK_DELTA}`)
  .max(MAX_STOCK_DELTA, `增減量不可超過 ${MAX_STOCK_DELTA}`);

export const adjustStockInput = z.object({ id: productId, delta: stockDelta });
