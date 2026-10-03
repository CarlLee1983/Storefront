import { z } from "zod";
import { createGatewayCaller, GatewayError, type HttpGatewayConfig } from "../payments/gateway";

/**
 * 發票服務介面：App 的業務邏輯只依賴這個介面，不知道背後是模擬服務還是真實電子發票。
 * 開立以 `invoiceKey` 為冪等鍵（同一個鍵重送回同一張發票，不重複開立），並能以同一個鍵查證。
 * 明確拒絕（`invoice_failed`、4xx）丟 `GatewayError`；逾時、連不上與回應異常也丟 `GatewayError`，
 * 呼叫端無法從例外分辨發票是否已開立，必須先 `getInvoice` 查證。
 */
export interface InvoiceGateway {
  issueInvoice(input: IssueInvoiceInput): Promise<GatewayInvoice>;
  /** 查證一張發票；服務從未收過這個 `invoiceKey` 回 null。 */
  getInvoice(invoiceKey: string): Promise<GatewayInvoice | null>;
}

export interface IssueInvoiceInput {
  invoiceKey: string;
  /** 商家自己的參照，本站放訂單編號（字串）。 */
  merchantReference: string;
  amountTwd: number;
}

export interface GatewayInvoice {
  invoiceKey: string;
  invoiceNumber: string;
  merchantReference: string;
  amountTwd: number;
  /** 開立時間，UTC epoch 毫秒。 */
  issuedAt: number;
}

const invoiceSchema = z.object({
  invoiceKey: z.string(),
  invoiceNumber: z.string().min(1),
  merchantReference: z.string(),
  amountTwd: z.number(),
  issuedAt: z.number(),
});

/** 打模擬發票服務 HTTP API 的實作（與模擬金流閘道同一個網址與金鑰）。 */
export function createHttpInvoiceGateway(config: HttpGatewayConfig, fetchImpl?: typeof fetch): InvoiceGateway {
  const { call } = createGatewayCaller(config, fetchImpl);
  return {
    issueInvoice: (input) => call("/v1/invoices", "POST", invoiceSchema, input),
    async getInvoice(invoiceKey) {
      try {
        return await call(`/v1/invoices/${encodeURIComponent(invoiceKey)}`, "GET", invoiceSchema);
      } catch (error) {
        if (error instanceof GatewayError && error.status === 404 && error.code === "invoice_not_found") return null;
        throw error;
      }
    },
  };
}

/**
 * 發票服務丟出的錯誤該算「明確失敗」還是「結果不明」（比照退款 `isExplicitRefundFailure`）：
 * 服務有回應並明確拒絕（`invoice_failed`，或 4xx 的請求被拒；`invoice_conflict` 例外，視為不明）→ 確定這次沒開成，可補辦；
 * 連不上、逾時、5xx、回應格式不符、408、429 → 可能已開立也可能沒有，必須先查證。
 */
export function isExplicitInvoiceFailure(error: GatewayError): boolean {
  if (error.code === "invoice_failed") return true;
  // 冪等鍵對到另一張不同的發票：發票服務與本站記錄矛盾，不能當作沒開成而重送，須人工查核
  if (error.code === "invoice_conflict" || error.code === "invoice_timeout" || error.code === "invalid_response" || error.status === null) return false;
  return error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429;
}
