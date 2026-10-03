import { toNumber, toText } from "../shared/form-values";

/** 表單裡 `<前綴>-<訂單明細編號>` 欄位的明細編號與數值（欄位原樣取值，不合法的交給 App 驗證）。 */
function lineFields(form: FormData, prefix: string): { orderLineId: number; value: number }[] {
  return [...form.entries()].flatMap(([key, value]) => {
    const match = new RegExp(`^${prefix}-(\\d+)$`).exec(key);
    return match ? [{ orderLineId: Number(match[1]), value: toNumber(value) }] : [];
  });
}

/** 記錄收回表單 → RPC 輸入：每筆明細一個 `received-<明細編號>` 欄位（實際收到的數量，0 表示沒收到）。 */
export function receiptFormToInput(form: FormData) {
  return {
    requestId: toNumber(form.get("requestId")),
    items: lineFields(form, "received").map(({ orderLineId, value }) => ({ orderLineId, receivedQuantity: value })),
    note: toText(form.get("note")),
  };
}

/** 記錄檢查表單 → RPC 輸入：每筆有收到的明細各有 `sellable-<明細編號>` 與 `damaged-<明細編號>` 兩個欄位。 */
export function inspectionFormToInput(form: FormData) {
  const damaged = new Map(lineFields(form, "damaged").map(({ orderLineId, value }) => [orderLineId, value]));
  return {
    requestId: toNumber(form.get("requestId")),
    items: lineFields(form, "sellable").map(({ orderLineId, value }) => ({ orderLineId, sellableQuantity: value, damagedQuantity: damaged.get(orderLineId) ?? Number.NaN })),
    note: toText(form.get("note")),
  };
}

/** 報廢表單 → RPC 輸入。 */
export function scrapFormToInput(form: FormData) {
  return { variantId: toNumber(form.get("variantId")), quantity: toNumber(form.get("quantity")), reason: toText(form.get("reason")) };
}

/** 退貨操作失敗結果 → 頁面上顯示的訊息；`unauthorized` 由頁面另外處理（403）。 */
export function describeReturnFailure(result: { reason: string; fields?: Record<string, string[]> }) {
  const messages: Record<string, string> = {
    invalid_input: "輸入有誤，請修正後再送出",
    return_not_found: "找不到這案退貨申請",
    return_already_decided: "這案已經做出相反的決定，請重新整理頁面確認最新狀態",
    return_wrong_state: "這案目前的進度不能做這個操作，或內容與先前記錄的不同，請重新整理頁面確認最新狀態",
    return_item_invalid: "明細與申請對不上，或數量超過申請數量／加不起來（良品加損壞品必須等於實際收到的數量）",
    insufficient_unavailable: "報廢數量超過已檢查確認的損壞品數量（待檢中的退貨還不能報廢）",
    variant_not_found: "找不到這個變體",
  };
  return { message: messages[result.reason] ?? "操作失敗，請稍後再試", fields: result.fields ?? {} };
}

/** 操作成功後的提示（redirect 帶回的 `saved` 參數）；不認得的回 null。檢查完成時附上退款目前的進度。 */
export function describeReturnOutcome(saved: string | null, refundStatus: string | null): string | null {
  switch (saved) {
    case "return-approved":
      return "已核准這案退貨申請，已通知顧客；收到商品後請記錄收回。";
    case "return-rejected":
      return "已拒絕這案退貨申請，數量釋出，已通知顧客。";
    case "return-received":
      return "已記錄收回：實際收到的數量已計入實體在庫與不可售（待檢）。請接著記錄檢查。";
    case "return-not-received":
      return "已記錄為沒有收到商品，這案已結案，數量釋出，庫存與款項都沒有變動。";
    case "return-inspected":
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
    default:
      return `${base}退款尚未登記（可退額度被其他退款占用），請查看訂單的退款紀錄。`;
  }
}
