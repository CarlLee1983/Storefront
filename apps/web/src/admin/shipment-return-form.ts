import { toNumber, toText } from "../shared/form-values";

/** 表單裡 `<前綴>-<訂單明細編號>` 欄位的明細編號與原始值（不合法的交給 App 驗證）。 */
function lineFields(form: FormData, prefix: string): Map<number, FormDataEntryValue> {
  return new Map(
    [...form.entries()].flatMap(([key, value]): [number, FormDataEntryValue][] => {
      const match = new RegExp(`^${prefix}-(\\d+)$`).exec(key);
      return match ? [[Number(match[1]), value]] : [];
    }),
  );
}

const isBlank = (value: FormDataEntryValue | undefined) => value === undefined || toText(value).trim() === "";

/**
 * 登記物流退回表單 → RPC 輸入：每筆批次明細各有 `returned-<明細編號>`（退回的數量）與 `found-<明細編號>`（其中先前確認遺失、被物流尋回的數量）兩個欄位，
 * 留空或 0 表示沒有；兩者都沒填的明細不送。其餘（負數、超量、非數字）原樣交給 App 驗證。`returnKey` 是表單一次提交的冪等鍵。
 */
export function declareReturnFormToInput(form: FormData) {
  const returned = lineFields(form, "returned");
  const found = lineFields(form, "found");
  const lineIds = [...new Set([...returned.keys(), ...found.keys()])].sort((a, b) => a - b);
  const items = lineIds.flatMap((orderLineId) => {
    const quantity = isBlank(returned.get(orderLineId)) ? 0 : toNumber(returned.get(orderLineId));
    const foundLostQuantity = isBlank(found.get(orderLineId)) ? 0 : toNumber(found.get(orderLineId));
    return quantity === 0 && foundLostQuantity === 0 ? [] : [{ orderLineId, quantity, foundLostQuantity }];
  });
  return { shipmentId: toNumber(form.get("shipmentId")), returnKey: toText(form.get("returnKey")), items, note: toText(form.get("note")) };
}

/** 記錄收回表單 → RPC 輸入：每筆明細一個 `received-<明細編號>` 欄位（實際收到的數量，0 表示沒收到），有尋回遺失品的明細另有 `receivedfound-<明細編號>`；沒有這個欄位視為 0。 */
export function shipmentReturnReceiptFormToInput(form: FormData) {
  const found = lineFields(form, "receivedfound");
  return {
    returnId: toNumber(form.get("returnId")),
    items: [...lineFields(form, "received")].map(([orderLineId, value]) => ({ orderLineId, receivedQuantity: toNumber(value), receivedFoundLostQuantity: found.has(orderLineId) ? toNumber(found.get(orderLineId)) : 0 })),
    note: toText(form.get("note")),
  };
}

/** 記錄檢查表單 → RPC 輸入：每筆有收到的明細各有 `sellable-<明細編號>` 與 `damaged-<明細編號>` 兩個欄位。 */
export function shipmentReturnInspectionFormToInput(form: FormData) {
  const damaged = lineFields(form, "damaged");
  return {
    returnId: toNumber(form.get("returnId")),
    items: [...lineFields(form, "sellable")].map(([orderLineId, value]) => ({ orderLineId, sellableQuantity: toNumber(value), damagedQuantity: damaged.has(orderLineId) ? toNumber(damaged.get(orderLineId)) : Number.NaN })),
    note: toText(form.get("note")),
  };
}

/** 物流退回操作失敗結果 → 頁面上顯示的訊息；`unauthorized` 由頁面另外處理（403）。 */
export function describeShipmentReturnFailure(result: { reason: string; fields?: Record<string, string[]> }) {
  const messages: Record<string, string> = {
    invalid_input: "輸入有誤，請至少填一筆退回數量並修正後再送出",
    shipment_not_found: "找不到這個出貨批次",
    shipment_delivered: "這一批已經送達，不能登記物流退回",
    return_line_invalid: "選擇的商品不在這一批裡，請重新整理頁面後再填",
    return_quantity_exceeded: "退回數量超過這一批還能登記的數量（可能已遺失、被退貨申請或別案退回占用；尋回的遺失品不可超過已確認遺失的數量）",
    return_key_conflict: "這次提交的內容與同一份表單先前送出的不同，請重新整理頁面後再填",
    shipment_return_not_found: "找不到這案物流退回",
    shipment_return_wrong_state: "這案目前的進度不能做這個操作，或內容與先前記錄的不同，請重新整理頁面確認最新狀態",
    shipment_return_item_invalid: "明細與登記對不上，或數量超過登記數量／加不起來（良品加損壞品必須等於實際收到的數量）",
  };
  return { message: messages[result.reason] ?? "操作失敗，請稍後再試", fields: result.fields ?? {} };
}

/** 操作成功後的提示（redirect 帶回的 `saved` 參數）；不認得的回 null。檢查完成時附上退款目前的進度。 */
export function describeShipmentReturnOutcome(saved: string | null, refundStatus: string | null): string | null {
  switch (saved) {
    case "return-declared":
      return "已登記物流退回：批次進度成為「退回倉庫」，不動庫存與款項，已通知顧客；商品實際到倉後請記錄收回。";
    case "shipment-return-received":
      return "已記錄收回：實際收到的數量已計入實體在庫與不可售（待檢）。請接著記錄檢查。";
    case "shipment-return-not-received":
      return "已記錄為沒有收到商品，這案已結案，數量釋出，庫存與款項都沒有變動。";
    case "shipment-return-inspected":
      break;
    default:
      return null;
  }
  const base = "已記錄檢查：良品轉為可售、損壞品留在不可售（可到退貨處理報廢），已通知顧客。";
  switch (refundStatus) {
    case "succeeded":
      return `${base}退款已成功退回。`;
    case "failed":
    case "unknown":
    case "pending":
    case "processing":
      return `${base}退款尚未完成（不影響已發生的庫存變動），請到退款待辦處理。`;
    case "none":
    case null:
      return `${base}沒有登記退款：沒有需要退款的金額，或可退額度被其他退款占用，請查看訂單的退款紀錄。`;
    default:
      return base;
  }
}
