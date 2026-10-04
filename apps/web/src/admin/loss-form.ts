import { toNumber, toText } from "../shared/form-values";

/**
 * 確認遺失表單 → RPC 輸入：每筆批次明細一個 `lost-<訂單明細編號>` 欄位（遺失數量），留空或 0 表示沒遺失；
 * 其餘（負數、超量、非數字）原樣交給 App 驗證。`lossKey` 是表單一次提交的冪等鍵，重送同一次提交不會建立第二案。
 */
export function lossFormToInput(form: FormData) {
  const items = [...form.entries()].flatMap(([key, value]) => {
    const match = /^lost-(\d+)$/.exec(key);
    if (!match || toText(value).trim() === "" || toNumber(value) === 0) return [];
    return [{ orderLineId: Number(match[1]), quantity: toNumber(value) }];
  });
  return { shipmentId: toNumber(form.get("shipmentId")), lossKey: toText(form.get("lossKey")), items, note: toText(form.get("note")) };
}

/** 確認遺失失敗結果 → 頁面上顯示的訊息；`unauthorized` 由頁面另外處理（403）。 */
export function describeLossFailure(result: { reason: string; fields?: Record<string, string[]> }) {
  const messages: Record<string, string> = {
    invalid_input: "輸入有誤，請至少填一筆遺失數量並修正後再送出",
    shipment_not_found: "找不到這個出貨批次",
    shipment_delivered: "這一批已經送達，不能確認遺失",
    loss_line_invalid: "選擇的商品不在這一批裡，請重新整理頁面後再填",
    loss_quantity_exceeded: "遺失數量超過這一批還能確認的數量（可能已遺失，或被退貨申請占用，請先處理退貨申請）",
    loss_key_conflict: "這次提交的內容與同一份表單先前送出的不同，請重新整理頁面後再填",
  };
  return { message: messages[result.reason] ?? "確認遺失失敗，請稍後再試", fields: result.fields ?? {} };
}

/** 確認遺失成功後的提示（redirect 帶回的 `saved` 與 `refund` 參數）；不認得的回 null。附上退款目前的進度。 */
export function describeLossOutcome(saved: string | null, refundStatus: string | null): string | null {
  if (saved !== "loss-confirmed") return null;
  const base = "已確認這批商品遺失：不回補庫存、不補寄，已通知顧客。";
  switch (refundStatus) {
    case "succeeded":
      return `${base}退款已成功退回。`;
    case "failed":
    case "unknown":
    case "pending":
    case "processing":
      return `${base}退款尚未完成（不影響遺失的確認），請到退款待辦處理。`;
    default:
      return `${base}退款尚未登記（可退額度被其他退款占用），請查看訂單的退款紀錄，額度釋出後可重新登記。`;
  }
}
