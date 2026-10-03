import { formatDateTime, orderStatusLabel } from "../orders/labels";

/** UTF-8 BOM：Excel 靠它辨認 UTF-8，中文才不會變亂碼。 */
export const CSV_BOM = "\uFEFF";

/** 匯出一列（`exportOrdersForAdmin` 的 `rows` 元素）。 */
export interface ExportRow {
  id: number;
  createdAt: number;
  customerEmail: string;
  status: string;
  totalTwd: number;
  needsAttention: boolean;
  paidTwd: number;
  refundedTwd: number;
  orderedQuantity: number;
  shippedQuantity: number;
  cancelledQuantity: number;
  returnedQuantity: number;
  lostQuantity: number;
  shipmentReturnedQuantity: number;
  invoiceNumbers: string;
  pendingAllowances: number;
}

const HEADER = ["訂單編號", "成立時間", "顧客 email", "訂單狀態", "總金額", "付款需要處理", "已收款", "已退款", "訂購數量", "已交運", "已取消", "已退貨", "已遺失", "物流退回", "發票號碼", "待折讓筆數"];

/** 這幾個開頭字元會被試算表當成公式執行（CSV injection）；Tab 與 CR 是它們的變形。 */
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

/** 單一儲存格：文字若以公式字元開頭，前面補單引號讓試算表當純文字；含逗號、引號、換行時加引號並把引號重複一次。數字原樣輸出。 */
export function csvCell(value: string | number): string {
  if (typeof value === "number") return String(value);
  const safe = FORMULA_PREFIX.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

const csvLine = (cells: (string | number)[]) => `${cells.map(csvCell).join(",")}\r\n`;

/** 標題列（含 BOM）。 */
export const csvHeader = (): string => CSV_BOM + csvLine(HEADER);

/** 一批資料列。 */
export function csvRows(rows: ExportRow[]): string {
  return rows.map((row) => csvLine([
    row.id, formatDateTime(row.createdAt), row.customerEmail, orderStatusLabel(row.status), row.totalTwd, row.needsAttention ? "是" : "",
    row.paidTwd, row.refundedTwd, row.orderedQuantity, row.shippedQuantity, row.cancelledQuantity, row.returnedQuantity, row.lostQuantity, row.shipmentReturnedQuantity,
    row.invoiceNumbers, row.pendingAllowances,
  ])).join("");
}
