import { z } from "zod";
import { wholeNumber } from "../shared/input";
import { MAX_SLUG_LENGTH, SLUG_PATTERN } from "./slug";

// 上限：擋掉明顯的手誤與亂填，不是業務規則
const MAX_NAME_LENGTH = 50;
const MAX_DESCRIPTION_LENGTH = 100;

export const categoryId = wholeNumber("分類編號").positive("分類編號無效");

const name = z
  .string({ error: "名稱必須是文字" })
  .trim()
  .min(1, "名稱不可為空")
  .max(MAX_NAME_LENGTH, `名稱不可超過 ${MAX_NAME_LENGTH} 個字`);

/** 一行說明：必填，不可換行。 */
const description = z
  .string({ error: "說明必須是文字" })
  .trim()
  .min(1, "說明不可為空")
  .max(MAX_DESCRIPTION_LENGTH, `說明不可超過 ${MAX_DESCRIPTION_LENGTH} 個字`)
  .refine((value) => !/[\r\n]/.test(value), "說明必須是單行文字");

/** 代稱的格式不在這裡驗：格式錯誤要回專屬的 `invalid_slug`，而不是 `invalid_input`。 */
export const createCategoryInput = z.object({
  slug: z.string({ error: "代稱必須是文字" }),
  name,
  description,
});

/** 修改分類：只能改名稱與說明；多帶的欄位（包含 `slug`）一律忽略，代稱沒有任何修改途徑。 */
export const updateCategoryInput = z.object({ id: categoryId, name, description });
export const categoryIdInput = z.object({ id: categoryId });

/** 前台依代稱取分類；任何不合法的輸入都等同找不到，由呼叫端處理。 */
export const categorySlugInput = z.object({ slug: z.string().max(MAX_SLUG_LENGTH).regex(SLUG_PATTERN) });
