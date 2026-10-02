import { z } from "zod";
import { PAYMENT_STATUSES, type PaymentStatus } from "./shared";

/**
 * 金流閘道介面（Payment Gateway）：App 的業務邏輯只依賴這一個介面，不知道背後是模擬閘道還是 Stripe。
 * 換閘道只需要實作這個介面；四個能力缺一不可（見 issue #10 的補充）：
 * 建立付款、查詢付款、退款（冪等）、取消付款（讓進行中的付款失效，取消後狀態是 `expired`）。
 * Webhook 的簽章驗證在 Web Worker，不在這裡。
 */
export interface PaymentGateway {
  createPayment(input: CreatePaymentInput): Promise<CreatedPayment>;
  /** 查詢付款狀態；`eventId` 是最近一個付款結果事件的 ID，與 webhook 的 eventId 相同，讓兩條路徑共用冪等鍵。 */
  getPayment(gatewayPaymentId: string): Promise<GatewayPayment>;
  /** 退款是冪等的：已經退款的付款再退一次仍然成功。 */
  refund(gatewayPaymentId: string): Promise<{ paymentId: string; status: "refunded" }>;
  /** 讓進行中的付款失效；已失效視為成功。 */
  cancel(gatewayPaymentId: string): Promise<{ paymentId: string; status: "expired" }>;
}

export interface CreatePaymentInput {
  /** 商家自己的參照，本站放訂單編號（字串）。 */
  merchantReference: string;
  amountTwd: number;
  /** 顧客付完款被導回的網址（閘道會附上 `?paymentId=`）。 */
  returnUrl: string;
  /** 閘道回呼付款結果的網址。 */
  webhookUrl: string;
  /** 付款最晚失效的時間（UTC epoch 毫秒）；本站放訂單的付款期限，付款有效期因此不會超過它。閘道可以更早失效，但不能更晚。 */
  expiresAt: number;
}

export interface CreatedPayment {
  /** 閘道付款 ID。 */
  paymentId: string;
  /** 顧客付款的頁面網址。 */
  paymentUrl: string;
  /** 付款失效時間，UTC epoch 毫秒。 */
  expiresAt: number;
}

/** 閘道的付款狀態與本站付款的狀態是同一組（見 `shared.ts`）。 */
export type GatewayPaymentStatus = PaymentStatus;

export interface GatewayPayment {
  paymentId: string;
  status: GatewayPaymentStatus;
  amountTwd: number;
  merchantReference: string;
  expiresAt: number;
  eventId: string | null;
}

/** 與閘道溝通失敗：連不上、回了錯誤、或回應格式不符。`status` 是 HTTP 狀態，沒有回應時為 null。 */
export class GatewayError extends Error {
  override name = "GatewayError";
  constructor(
    /** 閘道的錯誤碼，或本站自訂的 `unreachable`、`invalid_response`。 */
    readonly code: string,
    readonly status: number | null,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

const createdSchema = z.object({ paymentId: z.string(), paymentUrl: z.url({ protocol: /^https?$/ }), expiresAt: z.number() });
const paymentSchema = z.object({
  paymentId: z.string(),
  status: z.enum(PAYMENT_STATUSES),
  amountTwd: z.number(),
  merchantReference: z.string(),
  expiresAt: z.number(),
  eventId: z.string().nullable(),
});
const refundedSchema = z.object({ paymentId: z.string(), status: z.literal("refunded") });
const cancelledSchema = z.object({ paymentId: z.string(), status: z.literal("expired") });
const successSchema = z.object({ ok: z.literal(true), data: z.unknown() });
const errorSchema = z.object({ ok: z.literal(false), error: z.object({ code: z.string(), message: z.string() }) });

/** 每次呼叫閘道最久等多久；逾時視為連不上（`unreachable`），不讓卡住的閘道拖住呼叫端（例如 Cron）。 */
export const GATEWAY_TIMEOUT_MS = 5_000;

export interface HttpGatewayConfig {
  baseUrl: string;
  apiKey: string;
}

/** 打模擬閘道 HTTP API 的實作；`fetchImpl` 預設是全域 `fetch`（呼叫當下才取，測試可以攔截）。 */
export function createHttpGateway(
  { baseUrl, apiKey }: HttpGatewayConfig,
  fetchImpl: typeof fetch = (input, init) => globalThis.fetch(input, init),
): PaymentGateway {
  const root = baseUrl.replace(/\/+$/, "");

  async function call<S extends z.ZodType>(path: string, method: "GET" | "POST", schema: S, body?: unknown): Promise<z.output<S>> {
    const timeout = AbortSignal.timeout(GATEWAY_TIMEOUT_MS);
    // 不依賴 fetch 一定會理會 signal：逾時也直接放棄等待（回應本體同樣計入這個期限）
    const expired = new Promise<never>((_resolve, reject) => timeout.addEventListener("abort", () => reject(timeout.reason), { once: true }));
    expired.catch(() => undefined);
    let response: Response;
    let json: unknown;
    try {
      response = await Promise.race([
        fetchImpl(`${root}${path}`, {
          method,
          headers: { Authorization: `Bearer ${apiKey}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
          body: body === undefined ? undefined : JSON.stringify(body),
          // 閘道的網址是設定值，不跟隨導向
          redirect: "manual",
          signal: timeout,
        }),
        expired,
      ]);
      json = await Promise.race([response.json().catch(() => undefined), expired]);
    } catch (cause) {
      throw new GatewayError("unreachable", null, `連不上金流閘道：${method} ${path}`, { cause });
    }
    if (!response.ok) {
      const failure = errorSchema.safeParse(json);
      if (failure.success) throw new GatewayError(failure.data.error.code, response.status, failure.data.error.message);
      throw new GatewayError("invalid_response", response.status, `金流閘道回了 ${response.status}，內容不是預期的錯誤格式`);
    }
    const envelope = successSchema.safeParse(json);
    const data = envelope.success ? schema.safeParse(envelope.data.data) : undefined;
    if (!data?.success) throw new GatewayError("invalid_response", response.status, `金流閘道的回應格式不符：${method} ${path}`);
    return data.data;
  }

  const paymentPath = (gatewayPaymentId: string) => `/v1/payments/${encodeURIComponent(gatewayPaymentId)}`;

  return {
    async createPayment(input) {
      const created = await call("/v1/payments", "POST", createdSchema, input);
      // 顧客會被導去這個網址：必須就在我們設定的閘道上，不能是回應裡任意指定的網站
      if (new URL(created.paymentUrl).origin !== new URL(root).origin) {
        throw new GatewayError("invalid_response", null, "金流閘道回的付款頁網址不在設定的閘道網域上");
      }
      return created;
    },
    getPayment: (id) => call(paymentPath(id), "GET", paymentSchema),
    refund: (id) => call(`${paymentPath(id)}/refund`, "POST", refundedSchema),
    cancel: (id) => call(`${paymentPath(id)}/cancel`, "POST", cancelledSchema),
  };
}
