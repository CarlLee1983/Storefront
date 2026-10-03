import { drizzle } from "drizzle-orm/d1";
import { deliverNoticeSafely } from "../contact/notify";
import { fail, ok } from "../shared/result";
import type { Clock } from "../shared/clock";
import { GatewayError } from "../payments/gateway";
import { createAllowanceService } from "./allowance-service";
import { selectAllowanceToRun } from "./allowance-queries";
import { isExplicitInvoiceFailure, type GatewayInvoice, type InvoiceGateway } from "./gateway";
import { recordInvoiceAttempt, selectInvoiceToRun, selectInvoiceToRunByPayment, type InvoiceToRun } from "./queries";
import type { InvoiceStatus } from "./shared";

/**
 * 模擬發票的開立 service。`gateway` 是 null 表示付款設定不全（發票服務與金流閘道同一組設定）：需要發票服務的操作回 `payment_unavailable`（fail closed），開立義務仍留著。
 * 業務邏輯只依賴 `InvoiceGateway` 介面。
 */
export function createInvoiceService(d1: D1Database, clock: Clock, gateway: InvoiceGateway | null) {
  const db = drizzle(d1);
  const allowances = createAllowanceService(d1, clock, gateway);

  /** 發票服務回的冪等鍵、金額與商家參照必須與本站記錄一致，否則不信任這個回應（結果當作不明）。 */
  function invoiceMatches(found: GatewayInvoice, invoice: InvoiceToRun): boolean {
    if (found.invoiceKey === invoice.gatewayInvoiceKey && found.amountTwd === invoice.amountTwd && found.merchantReference === String(invoice.orderId)) return true;
    console.error(JSON.stringify({ event: "invoice_gateway_mismatch", invoiceId: invoice.id, orderId: invoice.orderId }));
    return false;
  }

  /**
   * 執行（或補辦）一張發票的開立，首次開立與管理員補辦共用；`actor` 是 `system` 或管理員 email，記在每次嘗試上。
   * 發票服務以發票的 `gateway_invoice_key` 為冪等鍵，所以重送、並行與補辦都不會重複開立（本地也只會有一次 pending → issued）：
   * 1. 結果不明的先向發票服務查證，不盲目重送：服務說已開立就記成功；從未收過才接著送出；查證本身失敗仍是不明。
   * 2. 送出：成功記成功；服務明確拒絕記失敗（留待補辦）；連不上、逾時、回應異常記不明。
   * 每次嘗試與狀態在同一個 batch 寫入，成功時發票通知信也同一個 batch（outbox），之後才投遞（出錯只記 log）。
   * 開立失敗不影響付款、出貨或退款：這裡只寫發票自己的紀錄。沒有閘道設定回 `payment_unavailable`，什麼都不改。
   */
  async function runInvoice(invoiceId: number, actor: string) {
    if (!gateway) return fail("payment_unavailable");
    const invoice = await selectInvoiceToRun(db, invoiceId);
    if (!invoice) return fail("invoice_not_found");
    if (invoice.status === "issued") {
      await deliverNoticeSafely(db, `invoice:${invoiceId}`, clock.now());
      await allowances.settleForPayment(invoice.paymentId);
      return ok({ status: "issued" as InvoiceStatus });
    }

    const record = (step: { action: "send" | "verify"; outcome: "succeeded" | "failed" | "unknown" | "not_found"; code?: string; status: "issued" | "failed" | "unknown" | null; invoiceNumber?: string }) =>
      recordInvoiceAttempt(d1, { invoiceId, actor, action: step.action, outcome: step.outcome, code: step.code ?? null, status: step.status, invoiceNumber: step.invoiceNumber }, clock.now());
    const finish = async (status: "issued" | "failed" | "unknown") => {
      if (status === "issued") {
        await deliverNoticeSafely(db, `invoice:${invoiceId}`, clock.now());
        // 原票開立成功（含補辦）：先前因原票未開立而等著的待折讓義務在這裡接手
        await allowances.settleForPayment(invoice.paymentId);
      }
      console.log(JSON.stringify({ event: "invoice_attempted", invoiceId, orderId: invoice.orderId, actor, status }));
      return ok({ status: (await selectInvoiceToRun(db, invoiceId))?.status ?? status });
    };
    const logGatewayError = (operation: string, error: unknown) => {
      if (!(error instanceof GatewayError)) throw error;
      console.error(JSON.stringify({ event: "invoice_gateway_failed", operation, code: error.code, status: error.status }));
    };

    if (invoice.status === "unknown") {
      let found;
      try {
        found = await gateway.getInvoice(invoice.gatewayInvoiceKey);
      } catch (error) {
        logGatewayError("getInvoice", error);
        await record({ action: "verify", outcome: "unknown", code: error instanceof GatewayError ? error.code : undefined, status: "unknown" });
        return finish("unknown");
      }
      if (found && !invoiceMatches(found, invoice)) {
        await record({ action: "verify", outcome: "unknown", code: "gateway_mismatch", status: "unknown" });
        return finish("unknown");
      }
      if (found) {
        await record({ action: "verify", outcome: "succeeded", status: "issued", invoiceNumber: found.invoiceNumber });
        return finish("issued");
      }
      // 服務從未收過這個冪等鍵：確定沒有開立，才接著送出
      await record({ action: "verify", outcome: "not_found", status: null });
    }

    try {
      const sent = await gateway.issueInvoice({ invoiceKey: invoice.gatewayInvoiceKey, merchantReference: String(invoice.orderId), amountTwd: invoice.amountTwd });
      if (!invoiceMatches(sent, invoice)) {
        await record({ action: "send", outcome: "unknown", code: "gateway_mismatch", status: "unknown" });
        return finish("unknown");
      }
      await record({ action: "send", outcome: "succeeded", status: "issued", invoiceNumber: sent.invoiceNumber });
      return finish("issued");
    } catch (error) {
      logGatewayError("issueInvoice", error);
      const code = error instanceof GatewayError ? error.code : undefined;
      const explicit = error instanceof GatewayError && isExplicitInvoiceFailure(error);
      await record({ action: "send", outcome: explicit ? "failed" : "unknown", code, status: explicit ? "failed" : "unknown" });
      return finish(explicit ? "failed" : "unknown");
    }
  }

  return {
    /** 管理員補辦一筆退款的折讓（`refundId` 是本站退款編號）：失敗的直接重送，結果不明的先查證；原票未開立回 `invoice_not_issued`；已折讓的冪等回成功。 */
    retryAllowance(refundId: number, actor: string) {
      return allowances.runAllowance(refundId, actor);
    },

    /**
     * 退款轉為成功之後折讓（`payments/service.ts` 的退款流程在 batch 之後呼叫；重試成功與重複呼叫也會呼叫）：
     * 原票已開立才送出，否則只保留義務、等原票開立後由 `runInvoice` 接手。任何錯誤都只記 log 並吞下：折讓不得讓退款失敗。
     */
    async allowForRefund(refundId: number): Promise<void> {
      try {
        const allowance = await selectAllowanceToRun(db, refundId);
        if (!allowance) {
          console.error(JSON.stringify({ event: "allowance_missing", refundId }));
          return;
        }
        if (allowance.invoiceStatus === "issued") await allowances.runAllowance(refundId, "system");
      } catch (error) {
        console.error(JSON.stringify({ event: "allowance_issue_failed", refundId, error: error instanceof Error ? error.message : String(error) }));
      }
    },

    /** 管理員補辦一張發票（`invoiceId` 是本站發票編號）：失敗的直接重送，結果不明的先查證；已開立的冪等回成功。 */
    retryInvoice(invoiceId: number, actor: string) {
      return runInvoice(invoiceId, actor);
    },

    /**
     * 付款成功後開立這筆收款的發票（「套用付款結果」在 batch 之後呼叫，事件重送時也會呼叫）：
     * 只處理剛登記、尚待開立的（`pending`）；失敗與不明由管理員在發票待辦補辦，已開立的只補上缺的首次投遞。
     * 任何錯誤都只記 log 並吞下：開立不得讓付款結果的套用失敗。
     */
    async issueForPayment(paymentId: number): Promise<void> {
      try {
        const invoice = await selectInvoiceToRunByPayment(db, paymentId);
        if (!invoice) {
          console.error(JSON.stringify({ event: "invoice_missing", paymentId }));
          return;
        }
        if (invoice.status === "issued" || invoice.status === "pending") await runInvoice(invoice.id, "system");
      } catch (error) {
        console.error(JSON.stringify({ event: "invoice_issue_failed", paymentId, error: error instanceof Error ? error.message : String(error) }));
      }
    },
  };
}

export type InvoiceService = ReturnType<typeof createInvoiceService>;
