import { z } from "zod";
import { createHttpInvoiceGateway, type InvoiceGateway } from "../invoices/gateway";
import { createHttpGateway, type PaymentGateway } from "./gateway";

const paymentEnvSchema = z.object({
  GATEWAY_BASE_URL: z.url({ protocol: /^https?$/ }),
  GATEWAY_API_KEY: z.string().min(1),
  // 瀏覽器看到的 Web Worker 公開 origin（與顧客登入共用同一個設定）：閘道的導回與 webhook 網址由它組成
  BETTER_AUTH_URL: z.url(),
});

export interface PaymentConfig {
  gateway: PaymentGateway;
  /** 模擬發票服務：與金流閘道同一個網址與金鑰。 */
  invoices: InvoiceGateway;
  /** Web Worker 的公開 origin，結尾沒有斜線。 */
  webOrigin: string;
}

/**
 * 付款設定：缺少或無效時回傳所有有問題的變數名稱（不含值），呼叫端據此 fail closed。
 * 只有付款與發票相關的 RPC（startPayment、confirmPayment、補開發票）會用到，設定不全不影響其他 RPC。
 */
export function readPaymentConfig(env: object): { ok: true; config: PaymentConfig } | { ok: false; invalid: string[] } {
  const parsed = paymentEnvSchema.safeParse(env);
  if (!parsed.success) return { ok: false, invalid: [...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))] };
  const values = parsed.data;
  return {
    ok: true,
    config: {
      gateway: createHttpGateway({ baseUrl: values.GATEWAY_BASE_URL, apiKey: values.GATEWAY_API_KEY }),
      invoices: createHttpInvoiceGateway({ baseUrl: values.GATEWAY_BASE_URL, apiKey: values.GATEWAY_API_KEY }),
      webOrigin: values.BETTER_AUTH_URL.replace(/\/+$/, ""),
    },
  };
}
