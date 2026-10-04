import { z } from "zod";
import { MAX_LINE_QUANTITY, MAX_ORDER_LINES, orderIdInput } from "../orders/input";
import { optionalText, requestKey } from "../shared/case-input";
import { wholeNumber } from "../shared/input";

const requestId = wholeNumber("退貨申請編號").positive("退貨申請編號無效");
const orderLineId = wholeNumber("訂單明細編號").positive("訂單明細編號無效");
const quantity = (label: string) => wholeNumber(label).min(0, `${label}不可為負數`).max(MAX_LINE_QUANTITY, `${label}不可超過 ${MAX_LINE_QUANTITY}`);

const shipmentId = wholeNumber("出貨批次編號").positive("出貨批次編號無效");

/** 一批退貨數量：有 `shipmentId` 表示自助申請（逐批判斷期限），沒有表示人工受理。 */
const returnItem = z.object({
  orderLineId,
  shipmentId: shipmentId.optional(),
  quantity: wholeNumber("數量").min(1, "數量必須是 1 以上的整數").max(MAX_LINE_QUANTITY, `數量不可超過 ${MAX_LINE_QUANTITY}`),
});

/** 同一次提交要嘛全部指定批次（自助），要嘛全部不指定（人工）；不指定時同一明細不可重複，指定時同一明細同一批不可重複。 */
const returnItems = z
  .array(returnItem, { error: "退貨明細必須是清單" })
  .min(1, "至少要選一筆明細")
  .max(MAX_ORDER_LINES * 5, `退貨明細不可超過 ${MAX_ORDER_LINES * 5} 筆`)
  .refine((list) => list.every((entry) => entry.shipmentId !== undefined) || list.every((entry) => entry.shipmentId === undefined), "自助申請的每筆都要指定出貨批次，人工受理則都不指定")
  .refine((list) => new Set(list.map((entry) => `${entry.orderLineId}:${entry.shipmentId ?? ""}`)).size === list.length, "同一筆訂單明細（同一批）不可重複出現");

/**
 * 顧客申請退貨：數量不可超過明細「已交運且未被其他退貨占用」的數量，由寫入端的條件保證。
 * 每筆帶 `shipmentId` 是自助申請：該批須已送達且在自助窗口內（`returns/window.ts`），且不超過該批數量；不帶是人工受理入口，不依期限擋下。
 */
export const requestReturnInput = z.object({ orderId: orderIdInput.shape.orderId, requestKey, items: returnItems, reason: optionalText("申請原因") });

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
