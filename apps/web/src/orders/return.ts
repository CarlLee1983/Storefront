import { toNumber, toText } from "../shared/form-values";
import { formatDateTime } from "./labels";

const STATUS_LABELS: Record<string, string> = {
  pending: "待審核",
  approved: "已核准，等待收回",
  rejected: "未獲核准",
  received: "已收到，檢查中",
  not_received: "未收到商品，已結案",
  completed: "已檢查完成",
};

/** 退貨申請進度的顯示名稱；不認得的狀態不顯示原始代碼。 */
export function returnStatusLabel(status: string): string {
  return Object.hasOwn(STATUS_LABELS, status) ? STATUS_LABELS[status]! : "狀態待確認";
}

const CUSTOMER_NOTES: Record<string, string> = {
  pending: "我們正在審核這個退貨申請，結果會通知你。",
  approved: "已核准：請依客服指示寄回商品，收回運費由商家負擔。我們收到並檢查後才會退款。",
  rejected: "這個申請未獲核准，商品不需寄回；如有疑問請聯絡客服。",
  received: "我們已收到退回的商品，正在檢查，完成後會依原實付單價退款。",
  not_received: "我們沒有收到這個申請的商品，申請已結案；如已寄出請聯絡客服。",
  completed: "已檢查完成並依原實付單價辦理退款；退款進度見「退款進度」。",
};

const COMPLETED_WITHOUT_REFUND = "已檢查完成；這筆退款目前還不能自動辦理，客服會與你聯繫處理。";

/** 顧客看的說明；檢查完成但退款尚未登記（額度被占用等）時不承諾「依序辦理」，改說明客服會聯繫。 */
export function customerReturnNote(status: string, refundRegistered = true): string {
  if (status === "completed" && !refundRegistered) return COMPLETED_WITHOUT_REFUND;
  return Object.hasOwn(CUSTOMER_NOTES, status) ? CUSTOMER_NOTES[status]! : "目前無法確認這個申請的進度，請稍後重新整理。";
}

/** 這筆明細還能申請退貨的數量：已交運、未被退貨申請占用（進行中與已退貨）、沒有確認遺失（遺失的已退款）、也沒有被物流退回。 */
export function returnableQuantity(line: { shippedQuantity: number; returnedQuantity: number; openReturnQuantity: number; lostQuantity: number; shipmentReturnedQuantity: number }): number {
  return Math.max(0, line.shippedQuantity - line.returnedQuantity - line.openReturnQuantity - line.lostQuantity - line.shipmentReturnedQuantity);
}

/**
 * 申請退貨表單 → RPC 輸入。人工受理的數量欄位名稱是 `return-<訂單明細編號>`，自助申請（逐批）是 `return-<訂單明細編號>-<出貨批次編號>`，
 * 留空或 0 表示不退；其餘（負數、超量、非數字）原樣交給 App 驗證。
 */
export function returnFormToInput(form: FormData, orderId: number) {
  const items = [...form.entries()].flatMap(([key, value]) => {
    const match = /^return-(\d+)(?:-(\d+))?$/.exec(key);
    if (!match || toText(value).trim() === "" || toNumber(value) === 0) return [];
    return [{ orderLineId: Number(match[1]), ...(match[2] === undefined ? {} : { shipmentId: Number(match[2]) }), quantity: toNumber(value) }];
  });
  return { orderId, requestKey: toText(form.get("requestKey")), items, reason: toText(form.get("reason")) };
}

/** App 回的一批自助窗口（`getMyOrder` 的 `returnBatches`）。 */
export interface ReturnBatch {
  deliveredAt: number | null;
  windowEndsAt: number | null;
  state: "not_delivered" | "open" | "closed";
}

/** 一批的自助退貨窗口說明：開放時說明期限，逾期與未送達都指向人工受理（不自動否決）。 */
export function returnBatchNote(batch: ReturnBatch): string {
  if (batch.state === "open" && batch.windowEndsAt !== null) return `可自助申請，至 ${formatDateTime(batch.windowEndsAt - 1)} 止（送達隔日起算 7 天）`;
  if (batch.state === "closed" && batch.windowEndsAt !== null) return `已超過自助申請期限（${formatDateTime(batch.windowEndsAt - 1)}），仍可用下方人工受理申請，由客服審核`;
  return "這批尚未送達或沒有可靠的送達日期，不能自助申請；仍可用下方人工受理申請，由客服審核";
}

/** 申請退貨失敗結果 → 頁面上顯示的訊息；`unauthorized` 由頁面另外處理（導去登入）。 */
export function describeReturnRequestFailure(result: { reason: string; fields?: Record<string, string[]> }) {
  const messages: Record<string, string> = {
    invalid_input: "輸入有誤，請修正後再送出",
    order_not_found: "找不到這張訂單",
    order_not_returnable: "這張訂單目前沒有已出貨的商品可以退貨",
    return_line_invalid: "選擇的明細不屬於這張訂單，請重新整理後再填",
    return_quantity_exceeded: "數量超過這筆明細還能退貨的數量（可能已有其他申請或已退過），請重新整理後再填",
    return_batch_invalid: "選擇的批次不屬於這張訂單，請重新整理後再填",
    shipment_not_delivered: "這批商品尚未送達，不能自助申請；請改用人工受理",
    return_window_closed: "這批已超過自助申請期限，請改用人工受理，由客服審核",
    request_key_conflict: "這次提交的內容與同一份表單先前送出的不同，請重新整理頁面後再填",
  };
  return { message: messages[result.reason] ?? "申請退貨失敗，請稍後再試", fields: result.fields ?? {} };
}

/** 顧客看的遺失說明：不補寄、需要再購買請重新下單；退款尚未登記（額度被占用等）時不承諾自動辦理，改說明客服會聯繫。 */
export function customerLossNote(refundRegistered: boolean, refundDue = true): string {
  const base = "物流確認這些商品在運送中遺失，不會補寄；如需再購買請重新下單。";
  if (!refundDue) return `${base}這些商品沒有需要退款的金額。`;
  return refundRegistered ? `${base}已依原實付單價辦理退款，進度見「退款進度」。` : `${base}這筆退款目前還不能自動辦理，客服會與你聯繫處理。`;
}

const SHIPMENT_RETURN_STATUS_LABELS: Record<string, string> = {
  returning: "物流退回中，等待到倉",
  received: "已收到，檢查中",
  not_received: "未收到商品，已結案",
  completed: "已檢查完成",
};

/** 物流退回進度的顯示名稱；不認得的狀態不顯示原始代碼。 */
export function shipmentReturnStatusLabel(status: string): string {
  return Object.hasOwn(SHIPMENT_RETURN_STATUS_LABELS, status) ? SHIPMENT_RETURN_STATUS_LABELS[status]! : "狀態待確認";
}

/**
 * 顧客看的物流退回說明：商品由物流送回倉庫，不會從這張訂單補寄、需要再購買請重新下單；收到並檢查後依原實付單價退款。
 * 完成後依退款是否登記分文案（沒有需要退款的金額、已登記、還不能自動辦理）。
 */
export function customerShipmentReturnNote(status: string, refundRegistered: boolean, refundDue: boolean): string {
  const base = "不會從這張訂單補寄，如需再購買請重新下單。";
  switch (status) {
    case "returning":
      return `物流把這些商品送回倉庫，我們收到並檢查後才會退款。${base}`;
    case "received":
      return `我們已收到物流退回的商品，正在檢查，完成後會依原實付單價退款。${base}`;
    case "not_received":
      return "物流退回的商品我們並沒有收到，這案已結案；如有疑問請聯絡客服。";
    case "completed":
      if (!refundDue) return `已檢查完成，這些商品沒有需要退款的金額。${base}`;
      return refundRegistered ? `已檢查完成並依原實付單價辦理退款，進度見「退款進度」。${base}` : `已檢查完成，這筆退款目前還不能自動辦理，客服會與你聯繫處理。${base}`;
    default:
      return "目前無法確認這案物流退回的進度，請稍後重新整理。";
  }
}
