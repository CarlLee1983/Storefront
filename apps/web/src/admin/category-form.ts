import { toNumber, toText } from "../shared/form-values";

/**
 * 建立分類表單 → RPC 輸入；欄位名稱都帶 `category` 前綴，避免和同一頁的新增商品表單撞名。
 * 不判斷內容是否合法（包含代稱格式），由 App 驗證。
 */
export function categoryFormToInput(form: FormData) {
  return {
    name: toText(form.get("categoryName")),
    description: toText(form.get("categoryDescription")),
    slug: toText(form.get("categorySlug")),
  };
}

/**
 * 商品編輯表單的分類下拉選單值：選了分類是編號、選「未分類」（空字串）是 `null`、
 * 欄位不存在是 `undefined`（不動分類）。非數字轉成 NaN，讓 App 回報錯誤，不默默清掉分類。
 */
export function categoryIdFromSelect(value: FormDataEntryValue | null): number | null | undefined {
  if (value === null) return undefined;
  return toText(value) === "" ? null : toNumber(value);
}
