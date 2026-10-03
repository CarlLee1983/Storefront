import { z } from "zod";
import { MAX_LINE_QUANTITY, MAX_ORDER_LINES, orderIdInput } from "../orders/input";
import { lineQuantities, optionalText, requestKey } from "../shared/case-input";
import { wholeNumber } from "../shared/input";

const requestId = wholeNumber("退貨申請編號").positive("退貨申請編號無效");
const orderLineId = wholeNumber("訂單明細編號").positive("訂單明細編號無效");
const quantity = (label: string) => wholeNumber(label).min(0, `${label}不可為負數`).max(MAX_LINE_QUANTITY, `${label}不可超過 ${MAX_LINE_QUANTITY}`);

/** 顧客申請退貨：數量不可超過明細「已交運且未被其他退貨占用」的數量，由寫入端的條件保證。 */
export const requestReturnInput = z.object({ orderId: orderIdInput.shape.orderId, requestKey, items: lineQuantities("退貨"), reason: optionalText("申請原因") });

export const decideReturnInput = z.object({
  requestId,
  decision: z.enum(["approve", "reject"], { error: "審核結果無效" }),
  note: optionalText("審核備註"),
});

const uniqueLines = (list: { orderLineId: number }[]) => new Set(list.map((entry) => entry.orderLineId)).size === list.length;

/** 記錄收回：每筆申請明細各填實際收到的數量（0 表示沒收到）；是否涵蓋全部明細、有沒有超過申請數量由寫入端核對。 */
export const recordReturnReceiptInput = z.object({
  requestId,
  items: z
    .array(z.object({ orderLineId, receivedQuantity: quantity("收到數量") }), { error: "收回明細必須是清單" })
    .min(1, "至少要填一筆明細")
    .max(MAX_ORDER_LINES, `收回明細不可超過 ${MAX_ORDER_LINES} 筆`)
    .refine(uniqueLines, "同一筆訂單明細不可重複出現"),
  note: optionalText("收回備註"),
});

/** 記錄檢查：每筆明細各填良品與損壞品數量，兩者相加必須等於實際收到的數量（由寫入端核對）。 */
export const recordReturnInspectionInput = z.object({
  requestId,
  items: z
    .array(z.object({ orderLineId, sellableQuantity: quantity("良品數量"), damagedQuantity: quantity("損壞品數量") }), { error: "檢查明細必須是清單" })
    .min(1, "至少要填一筆明細")
    .max(MAX_ORDER_LINES, `檢查明細不可超過 ${MAX_ORDER_LINES} 筆`)
    .refine(uniqueLines, "同一筆訂單明細不可重複出現"),
  note: optionalText("檢查備註"),
});

export type RequestReturnInput = z.output<typeof requestReturnInput>;
export type DecideReturnInput = z.output<typeof decideReturnInput>;
export type RecordReturnReceiptInput = z.output<typeof recordReturnReceiptInput>;
export type RecordReturnInspectionInput = z.output<typeof recordReturnInspectionInput>;
