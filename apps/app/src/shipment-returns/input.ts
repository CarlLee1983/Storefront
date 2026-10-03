import { z } from "zod";
import { MAX_LINE_QUANTITY, MAX_ORDER_LINES } from "../orders/input";
import { optionalText, requestKey } from "../shared/case-input";
import { wholeNumber } from "../shared/input";

const returnId = wholeNumber("物流退回編號").positive("物流退回編號無效");
const orderLineId = wholeNumber("訂單明細編號").positive("訂單明細編號無效");
const quantity = (label: string) => wholeNumber(label).min(0, `${label}不可為負數`).max(MAX_LINE_QUANTITY, `${label}不可超過 ${MAX_LINE_QUANTITY}`);
const uniqueLines = (list: { orderLineId: number }[]) => new Set(list.map((entry) => entry.orderLineId)).size === list.length;

/**
 * 管理員登記某一批的商品被物流退回倉庫：`returnKey` 是表單一次提交的冪等鍵。每筆明細填退回的數量（`quantity`）與其中先前確認遺失、之後被尋回的數量（`foundLostQuantity`），兩者不可同為 0；
 * 數量能不能退回（未送達、未被退貨與遺失占用、不超過該批數量、尋回不超過該批遺失）由寫入端的條件保證。
 */
export const declareShipmentReturnInput = z.object({
  shipmentId: wholeNumber("批次編號").positive("批次編號無效"),
  returnKey: requestKey,
  items: z
    .array(z.object({ orderLineId, quantity: quantity("退回數量"), foundLostQuantity: quantity("尋回遺失數量").default(0) }).refine((item) => item.quantity + item.foundLostQuantity > 0, "退回數量與尋回遺失數量不可同為 0"), { error: "退回明細必須是清單" })
    .min(1, "至少要填一筆明細")
    .max(MAX_ORDER_LINES, `退回明細不可超過 ${MAX_ORDER_LINES} 筆`)
    .refine(uniqueLines, "同一筆訂單明細不可重複出現"),
  note: optionalText("備註"),
});

/** 記錄收回：每筆明細各填實際收到的數量與其中尋回的遺失品數量（0 表示沒收到）；是否涵蓋全部明細、有沒有超過登記數量由寫入端核對。 */
export const recordShipmentReturnReceiptInput = z.object({
  returnId,
  items: z
    .array(z.object({ orderLineId, receivedQuantity: quantity("收到數量"), receivedFoundLostQuantity: quantity("收到的尋回遺失品數量").default(0) }), { error: "收回明細必須是清單" })
    .min(1, "至少要填一筆明細")
    .max(MAX_ORDER_LINES, `收回明細不可超過 ${MAX_ORDER_LINES} 筆`)
    .refine(uniqueLines, "同一筆訂單明細不可重複出現"),
  note: optionalText("收回備註"),
});

/** 記錄檢查：每筆明細各填良品與損壞品數量，兩者相加必須等於實際收到的數量（含尋回的遺失品，由寫入端核對）。 */
export const recordShipmentReturnInspectionInput = z.object({
  returnId,
  items: z
    .array(z.object({ orderLineId, sellableQuantity: quantity("良品數量"), damagedQuantity: quantity("損壞品數量") }), { error: "檢查明細必須是清單" })
    .min(1, "至少要填一筆明細")
    .max(MAX_ORDER_LINES, `檢查明細不可超過 ${MAX_ORDER_LINES} 筆`)
    .refine(uniqueLines, "同一筆訂單明細不可重複出現"),
  note: optionalText("檢查備註"),
});

export type DeclareShipmentReturnInput = z.output<typeof declareShipmentReturnInput>;
export type RecordShipmentReturnReceiptInput = z.output<typeof recordShipmentReturnReceiptInput>;
export type RecordShipmentReturnInspectionInput = z.output<typeof recordShipmentReturnInspectionInput>;
