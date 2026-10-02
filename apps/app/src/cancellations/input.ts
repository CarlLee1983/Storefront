import { z } from "zod";
import { MAX_LINE_QUANTITY, MAX_ORDER_LINES, orderIdInput } from "../orders/input";
import { wholeNumber } from "../shared/input";

const MAX_KEY_LENGTH = 64;
const MAX_TEXT_LENGTH = 200;

/** 一次提交的冪等鍵：表單渲染時產生一個，重送同一次提交帶同一個，不會重複建立申請。 */
const requestKey = z
  .string({ error: "提交識別碼必須是文字" })
  .regex(/^[A-Za-z0-9_-]+$/, "提交識別碼只能包含英數字、底線與連字號")
  .max(MAX_KEY_LENGTH, `提交識別碼不可超過 ${MAX_KEY_LENGTH} 個字`);

/** 申請原因與審核備註：選填，trim 後存；擋掉過長的輸入（不是業務規則）。 */
const optionalText = (label: string) =>
  z
    .string({ error: `${label}必須是文字` })
    .trim()
    .max(MAX_TEXT_LENGTH, `${label}不可超過 ${MAX_TEXT_LENGTH} 個字`)
    .optional()
    .transform((value) => value ?? "");

/** 申請取消的一筆明細：數量不可超過明細「未交運且未被其他申請占用」的數量，由寫入端的條件保證。 */
const item = z.object({
  orderLineId: wholeNumber("訂單明細編號").positive("訂單明細編號無效"),
  quantity: wholeNumber("數量").min(1, "數量必須是 1 以上的整數").max(MAX_LINE_QUANTITY, `數量不可超過 ${MAX_LINE_QUANTITY}`),
});

const items = z
  .array(item, { error: "取消明細必須是清單" })
  .min(1, "至少要選一筆明細")
  .max(MAX_ORDER_LINES, `取消明細不可超過 ${MAX_ORDER_LINES} 筆`)
  .refine((list) => new Set(list.map((entry) => entry.orderLineId)).size === list.length, "同一筆訂單明細不可重複出現");

export const requestCancellationInput = z.object({ orderId: orderIdInput.shape.orderId, requestKey, items, reason: optionalText("申請原因") });

export const decideCancellationInput = z.object({
  requestId: wholeNumber("取消申請編號").positive("取消申請編號無效"),
  decision: z.enum(["approve", "reject"], { error: "審核結果無效" }),
  note: optionalText("審核備註"),
});

export type RequestCancellationInput = z.output<typeof requestCancellationInput>;
export type DecideCancellationInput = z.output<typeof decideCancellationInput>;
