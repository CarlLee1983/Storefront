import type { CreatePaymentInput, GatewayPaymentStatus } from "../src/payments/gateway";
import { registerFetchRoute } from "./fetch-router";
import { TEST_GATEWAY_API_KEY, TEST_GATEWAY_BASE_URL } from "./constants";

interface FakePayment extends CreatePaymentInput {
  id: string;
  status: GatewayPaymentStatus;
  eventId: string | null;
}

/** 可操控的金流閘道替身：在 HTTP 層實作閘道的 API 契約（apps/gateway/README），由 `installFakeGateway` 攔截全域 fetch。 */
export class FakeGateway {
  readonly payments = new Map<string, FakePayment>();
  /** 收到的建立付款請求，依序。 */
  readonly created: CreatePaymentInput[] = [];
  readonly cancelled: string[] = [];
  /** 取消這些付款一律回 409 payment_not_cancellable。 */
  readonly uncancellable = new Set<string>();
  /** 下一次指定操作以此 HTTP 狀態失敗（用完即清）；0 表示連線失敗。 */
  private failures = new Map<string, number>();
  private counter = 0;
  /** 建立付款請求處理到一半（付款已成立、回應送出前）執行的動作，用來製造「呼叫閘道期間狀態變了」。 */
  onCreate: (() => Promise<void>) | undefined;

  failNext(operation: "create" | "get", status = 502): void {
    this.failures.set(operation, status);
  }

  /** 模擬顧客在付款頁按下結果：付款有了終局狀態與事件 ID（webhook 會帶同一個事件 ID）。 */
  settle(gatewayPaymentId: string, outcome: "succeeded" | "failed"): { eventId: string; gatewayPaymentId: string; outcome: "succeeded" | "failed" } {
    const payment = this.require(gatewayPaymentId);
    this.counter += 1;
    payment.status = outcome;
    payment.eventId = `evt_${this.counter}`;
    return { eventId: payment.eventId, gatewayPaymentId, outcome };
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
      const expiresAt = Math.min(Date.now() + 600_000, input.expiresAt);
      payment.expiresAt = expiresAt;
      return success({ paymentId: id, paymentUrl: `${TEST_GATEWAY_BASE_URL}/pay/${id}`, expiresAt }, 201);
    }
    const match = /^\/v1\/payments\/([A-Za-z0-9_]+)(\/cancel|\/refund)?$/.exec(url.pathname);
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
      // 已有結果的付款不能取消（與真實閘道一致）；`uncancellable` 可強制拒絕，模擬「其實已經成功」
      if (this.uncancellable.has(payment.id) || payment.status === "succeeded" || payment.status === "failed") {
        return error(409, "payment_not_cancellable");
      }
      this.cancelled.push(payment.id);
      payment.status = "expired";
      return success({ paymentId: payment.id, status: "expired" });
    }
    if (request.method === "POST" && match[2] === "/refund") {
      payment.status = "refunded";
      return success({ paymentId: payment.id, status: "refunded" });
    }
    return error(404, "not_found");
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
