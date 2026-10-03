import type { CreatePaymentInput, GatewayPaymentStatus } from "../src/payments/gateway";
import { registerFetchRoute } from "./fetch-router";
import { TEST_GATEWAY_API_KEY, TEST_GATEWAY_BASE_URL } from "./constants";

interface FakePayment extends CreatePaymentInput {
  id: string;
  status: GatewayPaymentStatus;
  eventId: string | null;
}

/** 閘道上的一筆退款（與真實閘道一致：以呼叫端給的 refundId 為冪等鍵）。 */
export interface FakeRefund {
  refundId: string;
  paymentId: string;
  amountTwd: number;
  status: "succeeded" | "failed";
}

/** 發票服務上的一張發票（與真實服務一致：以呼叫端給的 invoiceKey 為冪等鍵）。 */
export interface FakeInvoice {
  invoiceKey: string;
  invoiceNumber: string;
  merchantReference: string;
  amountTwd: number;
  issuedAt: number;
}

/** 可操控的金流閘道替身：在 HTTP 層實作閘道的 API 契約（apps/gateway/README），由 `installFakeGateway` 攔截全域 fetch。 */
export class FakeGateway {
  readonly payments = new Map<string, FakePayment>();
  /** 收到的建立付款請求，依序。 */
  readonly created: CreatePaymentInput[] = [];
  readonly cancelled: string[] = [];
  /** 閘道上的退款，鍵是 `<閘道付款 ID>/<refundId>`。 */
  readonly refunds = new Map<string, FakeRefund>();
  /** 閘道上已成功的退款所屬的閘道付款 ID，依建立順序（每筆成功的退款一項）。 */
  get refunded(): string[] {
    return [...this.refunds.values()].filter((refund) => refund.status === "succeeded").map((refund) => refund.paymentId);
  }
  /** 到達閘道、通過驗證的退款請求（含明確失敗與回應遺失的），依序；被 `failNext("refund")` 擋掉的不計。 */
  readonly refundRequests: { paymentId: string; refundId: string; amountTwd: number }[] = [];
  /** 下一次退款請求在閘道明確失敗（502 refund_failed，款項沒動）。 */
  private explicitRefundFailures = 0;
  /** 下一次退款請求在閘道成功，但回應遺失（呼叫端只看到連線失敗）。 */
  private lostRefundResponses = 0;
  /** 取消這些付款一律回 409 payment_not_cancellable。 */
  readonly uncancellable = new Set<string>();
  /** 下一次指定操作以此 HTTP 狀態失敗（用完即清）；0 表示連線失敗。 */
  private failures = new Map<string, number>();
  private counter = 0;
  /** 建立付款請求處理到一半（付款已成立、回應送出前）執行的動作，用來製造「呼叫閘道期間狀態變了」。 */
  onCreate: (() => Promise<void>) | undefined;
  /** 退款請求處理到一半（退款已成立、回應送出前）執行的動作，用來製造「呼叫閘道期間狀態變了」。 */
  /** 覆寫建立付款時回報的失效時間（參數是本站要求的失效時間），用來模擬回應不合法的閘道。 */
  expiresAtOverride: ((requested: number) => number) | undefined;
  onRefund: (() => Promise<void>) | undefined;
  /** 發票服務上已開立的發票，鍵是 invoiceKey。 */
  readonly invoices = new Map<string, FakeInvoice>();
  /** 到達發票服務、通過驗證的開立請求（含明確失敗與回應遺失的），依序。 */
  readonly invoiceRequests: { invoiceKey: string; merchantReference: string; amountTwd: number }[] = [];
  /** 下一次開立請求在服務明確失敗（502 invoice_failed，沒有開立）。 */
  private explicitInvoiceFailures = 0;
  /** 下一次開立請求在服務成功開立，但回應遺失（呼叫端只看到連線失敗）。 */
  private lostInvoiceResponses = 0;

  failNext(operation: "create" | "get" | "cancel" | "refund" | "getRefund" | "issueInvoice" | "getInvoice", status = 502): void {
    this.failures.set(operation, status);
  }

  /** 下一次退款請求閘道明確拒絕（502 refund_failed）：呼叫端確定款項沒有退回。 */
  failNextRefundExplicitly(): void {
    this.explicitRefundFailures += 1;
  }

  /** 下一次退款請求閘道已成功退回，但回應在途中遺失：呼叫端逾時，結果不明。 */
  loseNextRefundResponse(): void {
    this.lostRefundResponses += 1;
  }

  /** 下一次開立請求發票服務明確拒絕（502 invoice_failed）：呼叫端確定沒有開立。 */
  failNextInvoiceExplicitly(): void {
    this.explicitInvoiceFailures += 1;
  }

  /** 下一次開立請求發票服務已開立，但回應在途中遺失：呼叫端逾時，結果不明。 */
  loseNextInvoiceResponse(): void {
    this.lostInvoiceResponses += 1;
  }

  /** 這筆付款在閘道上已成功退回的累計金額。 */
  refundedTwd(gatewayPaymentId: string): number {
    return [...this.refunds.values()].filter((refund) => refund.paymentId === gatewayPaymentId && refund.status === "succeeded").reduce((total, refund) => total + refund.amountTwd, 0);
  }

  /** 模擬顧客在付款頁按下結果：付款有了終局狀態與事件 ID（webhook 會帶同一個事件 ID）。 */
  settle(gatewayPaymentId: string, outcome: "succeeded" | "failed"): { eventId: string; gatewayPaymentId: string; outcome: "succeeded" | "failed" } {
    const payment = this.require(gatewayPaymentId);
    this.counter += 1;
    payment.status = outcome;
    payment.eventId = `evt_${this.counter}`;
    return { eventId: payment.eventId, gatewayPaymentId, outcome };
  }

  /** 讓閘道知道一筆本地直接寫入的付款（測試安排「同一訂單有兩筆付款同時進行」這種正常流程做不到的前置狀態）。 */
  adopt(gatewayPaymentId: string, { amountTwd, merchantReference }: { amountTwd: number; merchantReference: string }): void {
    const expiresAt = Date.now() + 600_000;
    this.payments.set(gatewayPaymentId, {
      id: gatewayPaymentId,
      status: "pending",
      eventId: null,
      amountTwd,
      merchantReference,
      expiresAt,
      returnUrl: "",
      webhookUrl: "",
    });
  }

  /** 最近一次建立的閘道付款 ID。 */
  lastPaymentId(): string {
    const ids = [...this.payments.keys()];
    const last = ids[ids.length - 1];
    if (!last) throw new Error("閘道還沒有任何付款");
    return last;
  }

  private require(gatewayPaymentId: string): FakePayment {
    const payment = this.payments.get(gatewayPaymentId);
    if (!payment) throw new Error(`閘道沒有付款 ${gatewayPaymentId}`);
    return payment;
  }

  /** 處理一個打向閘道的請求。 */
  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.headers.get("Authorization") !== `Bearer ${TEST_GATEWAY_API_KEY}`) {
      return error(401, "unauthorized");
    }
    if (request.method === "POST" && url.pathname === "/v1/payments") {
      const failed = this.takeFailure("create");
      if (failed) return failed;
      const input = (await request.json()) as CreatePaymentInput;
      this.created.push(input);
      const id = `pay_${this.payments.size + 1}`;
      const payment: FakePayment = { ...input, id, status: "pending", eventId: null };
      this.payments.set(id, payment);
      await this.onCreate?.();
      // 與真實閘道一致：失效時間是 min(建立時間 + 10 分鐘, 要求的 expiresAt)
      const expiresAt = this.expiresAtOverride?.(input.expiresAt) ?? Math.min(Date.now() + 600_000, input.expiresAt);
      payment.expiresAt = expiresAt;
      return success({ paymentId: id, paymentUrl: `${TEST_GATEWAY_BASE_URL}/pay/${id}`, expiresAt }, 201);
    }
    if (url.pathname === "/v1/invoices" && request.method === "POST") return this.handleIssueInvoice(request);
    const invoiceLookup = /^\/v1\/invoices\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
    if (invoiceLookup && request.method === "GET") {
      const failed = this.takeFailure("getInvoice");
      if (failed) return failed;
      const found = this.invoices.get(invoiceLookup[1]!);
      return found ? success(found) : error(404, "invoice_not_found");
    }
    const match = /^\/v1\/payments\/([A-Za-z0-9_]+)(\/cancel|\/refunds(?:\/([A-Za-z0-9_-]+))?)?$/.exec(url.pathname);
    const payment = match ? this.payments.get(match[1]!) : undefined;
    if (!match || !payment) return error(404, "payment_not_found");
    if (request.method === "GET" && !match[2]) {
      const failed = this.takeFailure("get");
      if (failed) return failed;
      return success({
        paymentId: payment.id,
        status: payment.status,
        amountTwd: payment.amountTwd,
        merchantReference: payment.merchantReference,
        expiresAt: payment.expiresAt,
        eventId: payment.eventId,
      });
    }
    if (request.method === "POST" && match[2] === "/cancel") {
      const failed = this.takeFailure("cancel");
      if (failed) return failed;
      // 已有結果的付款不能取消（與真實閘道一致）；`uncancellable` 可強制拒絕，模擬「其實已經成功」
      if (this.uncancellable.has(payment.id) || payment.status === "succeeded" || payment.status === "failed") {
        return error(409, "payment_not_cancellable");
      }
      this.cancelled.push(payment.id);
      payment.status = "expired";
      return success({ paymentId: payment.id, status: "expired" });
    }
    if (match[2]?.startsWith("/refunds")) return this.handleRefund(request, payment, match[3]);
    return error(404, "not_found");
  }

  private async handleRefund(request: Request, payment: FakePayment, lookupId: string | undefined): Promise<Response> {
    if (request.method === "GET" && lookupId) {
      const failed = this.takeFailure("getRefund");
      if (failed) return failed;
      const found = this.refunds.get(`${payment.id}/${lookupId}`);
      return found ? success(found) : error(404, "refund_not_found");
    }
    if (request.method !== "POST" || lookupId) return error(404, "not_found");
    const failed = this.takeFailure("refund");
    if (failed) return failed;
    const { refundId, amountTwd } = (await request.json()) as { refundId: string; amountTwd: number };
    this.refundRequests.push({ paymentId: payment.id, refundId, amountTwd });
    await this.onRefund?.();
    const key = `${payment.id}/${refundId}`;
    const existing = this.refunds.get(key);
    if (existing && existing.amountTwd !== amountTwd) return error(409, "refund_conflict");
    if (existing?.status === "succeeded") return success(existing);
    if (payment.status !== "succeeded") return error(409, "payment_not_refundable");
    if (this.explicitRefundFailures > 0) {
      this.explicitRefundFailures -= 1;
      this.refunds.set(key, { refundId, paymentId: payment.id, amountTwd, status: "failed" });
      return error(502, "refund_failed");
    }
    if (this.refundedTwd(payment.id) + amountTwd > payment.amountTwd) return error(409, "refund_exceeds_payment");
    const refund: FakeRefund = { refundId, paymentId: payment.id, amountTwd, status: "succeeded" };
    this.refunds.set(key, refund);
    if (this.lostRefundResponses > 0) {
      this.lostRefundResponses -= 1;
      throw new TypeError("fetch failed");
    }
    return success(refund);
  }

  private async handleIssueInvoice(request: Request): Promise<Response> {
    const failed = this.takeFailure("issueInvoice");
    if (failed) return failed;
    const { invoiceKey, merchantReference, amountTwd } = (await request.json()) as { invoiceKey: string; merchantReference: string; amountTwd: number };
    this.invoiceRequests.push({ invoiceKey, merchantReference, amountTwd });
    const existing = this.invoices.get(invoiceKey);
    if (existing) return existing.amountTwd === amountTwd && existing.merchantReference === merchantReference ? success(existing) : error(409, "invoice_conflict");
    if (this.explicitInvoiceFailures > 0) {
      this.explicitInvoiceFailures -= 1;
      return error(502, "invoice_failed");
    }
    const invoice: FakeInvoice = { invoiceKey, invoiceNumber: `SM-${String(this.invoices.size + 1).padStart(8, "0")}`, merchantReference, amountTwd, issuedAt: Date.now() };
    this.invoices.set(invoiceKey, invoice);
    if (this.lostInvoiceResponses > 0) {
      this.lostInvoiceResponses -= 1;
      throw new TypeError("fetch failed");
    }
    return success(invoice);
  }

  private takeFailure(operation: string): Response | undefined {
    const status = this.failures.get(operation);
    if (status === undefined) return undefined;
    this.failures.delete(operation);
    if (status === 0) throw new TypeError("fetch failed");
    return error(status, "gateway_error");
  }
}

const success = (data: unknown, status = 200) => Response.json({ ok: true, data }, { status });
const error = (status: number, code: string) => Response.json({ ok: false, error: { code, message: code } }, { status });

/**
 * 讓打向 `TEST_GATEWAY_BASE_URL` 的請求交給替身（透過 `fetch-router`，與 OAuth stub 共用同一個攔截點，安裝順序不拘）。
 * 攔截在每個測試結束時自動解除。
 */
export function installFakeGateway(): FakeGateway {
  const fake = new FakeGateway();
  registerFetchRoute("gateway", (url) => url.startsWith(TEST_GATEWAY_BASE_URL), (request) => fake.handle(request));
  return fake;
}
