import { drizzle } from "drizzle-orm/d1";
import { deliverNoticeSafely } from "../contact/notify";
import { fail, ok } from "../shared/result";
import type { Clock } from "../shared/clock";
import { GatewayError } from "../payments/gateway";
import { isExplicitInvoiceFailure, type GatewayAllowance, type InvoiceGateway } from "./gateway";
import { recordAllowanceAttempt, selectAllowanceToRun, selectOpenAllowancesOfPayment, type AllowanceToRun } from "./allowance-queries";
import type { AllowanceStatus } from "./shared";

/**
 * 成功退款的逐筆折讓。`gateway` 是 null 表示付款設定不全：需要發票服務的操作回 `payment_unavailable`（fail closed），待折讓義務仍留著。
 * 流程與模擬發票的開立相同（交易外呼叫、沒有 processing 租約、以冪等鍵加本地條件更新防重複），只多一個前提：原票必須已開立。
 */
export function createAllowanceService(d1: D1Database, clock: Clock, gateway: InvoiceGateway | null) {
  const db = drizzle(d1);

  /** 發票服務回的折讓鍵、原票鍵與金額必須與本站記錄一致，否則不信任這個回應（結果當作不明）。 */
  function allowanceMatches(found: GatewayAllowance, allowance: AllowanceToRun): boolean {
    if (found.allowanceKey === allowance.gatewayAllowanceKey && found.invoiceKey === allowance.invoiceKey && found.amountTwd === allowance.amountTwd) return true;
    console.error(JSON.stringify({ event: "allowance_gateway_mismatch", refundId: allowance.refundId, orderId: allowance.orderId }));
    return false;
  }

  /**
   * 執行（或補辦）一筆退款的折讓，系統自動與管理員補辦共用；`actor` 是 `system` 或管理員 email，記在每次嘗試上。
   * 原票尚未開立（含失敗、結果不明）時不送出，回 `invoice_not_issued`、義務不動：不產生無原票的折讓，原票開立成功後由 `settleForPayment` 接手。
   * 1. 結果不明的先向發票服務查證，不盲目重送：服務說已折讓就記成功；從未收過才接著送出；查證本身失敗仍是不明。
   * 2. 送出：成功記成功；服務明確拒絕記失敗（留待補辦）；連不上、逾時、回應異常記不明。
   * 每次嘗試與狀態在同一個 batch 寫入，成功時折讓通知信也同一個 batch（outbox），之後才投遞（出錯只記 log）。
   * 折讓失敗不影響付款、出貨或退款：這裡只寫折讓自己的紀錄。
   */
  async function runAllowance(refundId: number, actor: string) {
    if (!gateway) return fail("payment_unavailable");
    const allowance = await selectAllowanceToRun(db, refundId);
    if (!allowance) return fail("allowance_not_found");
    if (allowance.status === "issued") {
      await deliverNoticeSafely(db, `allowance:${refundId}`, clock.now());
      return ok({ status: "issued" as AllowanceStatus });
    }
    if (allowance.invoiceStatus !== "issued" || allowance.invoiceKey === null) return fail("invoice_not_issued");
    const invoiceKey = allowance.invoiceKey;

    const record = (step: { action: "send" | "verify"; outcome: "succeeded" | "failed" | "unknown" | "not_found"; code?: string; status: "issued" | "failed" | "unknown" | null; allowanceNumber?: string }) =>
      recordAllowanceAttempt(d1, { allowanceId: allowance.id, refundId, actor, action: step.action, outcome: step.outcome, code: step.code ?? null, status: step.status, allowanceNumber: step.allowanceNumber }, clock.now());
    const finish = async (status: "issued" | "failed" | "unknown") => {
      if (status === "issued") await deliverNoticeSafely(db, `allowance:${refundId}`, clock.now());
      console.log(JSON.stringify({ event: "allowance_attempted", refundId, orderId: allowance.orderId, actor, status }));
      return ok({ status: (await selectAllowanceToRun(db, refundId))?.status ?? status });
    };
    const logGatewayError = (operation: string, error: unknown) => {
      if (!(error instanceof GatewayError)) throw error;
      console.error(JSON.stringify({ event: "allowance_gateway_failed", operation, code: error.code, status: error.status }));
    };

    if (allowance.status === "unknown") {
      let found;
      try {
        found = await gateway.getAllowance(allowance.gatewayAllowanceKey);
      } catch (error) {
        logGatewayError("getAllowance", error);
        await record({ action: "verify", outcome: "unknown", code: error instanceof GatewayError ? error.code : undefined, status: "unknown" });
        return finish("unknown");
      }
      if (found && !allowanceMatches(found, allowance)) {
        await record({ action: "verify", outcome: "unknown", code: "gateway_mismatch", status: "unknown" });
        return finish("unknown");
      }
      if (found) {
        await record({ action: "verify", outcome: "succeeded", status: "issued", allowanceNumber: found.allowanceNumber });
        return finish("issued");
      }
      // 服務從未收過這個冪等鍵：確定沒有折讓，才接著送出
      await record({ action: "verify", outcome: "not_found", status: null });
    }

    try {
      const sent = await gateway.issueAllowance({ allowanceKey: allowance.gatewayAllowanceKey, invoiceKey, amountTwd: allowance.amountTwd });
      if (!allowanceMatches(sent, allowance)) {
        await record({ action: "send", outcome: "unknown", code: "gateway_mismatch", status: "unknown" });
        return finish("unknown");
      }
      await record({ action: "send", outcome: "succeeded", status: "issued", allowanceNumber: sent.allowanceNumber });
      return finish("issued");
    } catch (error) {
      logGatewayError("issueAllowance", error);
      const code = error instanceof GatewayError ? error.code : undefined;
      const explicit = error instanceof GatewayError && isExplicitInvoiceFailure(error);
      await record({ action: "send", outcome: explicit ? "failed" : "unknown", code, status: explicit ? "failed" : "unknown" });
      return finish(explicit ? "failed" : "unknown");
    }
  }

  /**
   * 對一筆收款上所有尚未折讓的義務逐筆折讓（舊的在前），觸發點有三：退款轉為成功之後、原票開立成功（含補辦）之後、付款事件重送。
   * 原票尚未開立的義務不送出；任何錯誤都只記 log 並吞下：折讓不得讓退款或開立失敗。已折讓的不會再送。
   */
  async function settleForPayment(paymentId: number): Promise<void> {
    try {
      for (const { refundId } of await selectOpenAllowancesOfPayment(db, paymentId)) await runAllowance(refundId, "system");
    } catch (error) {
      console.error(JSON.stringify({ event: "allowance_settle_failed", paymentId, error: error instanceof Error ? error.message : String(error) }));
    }
  }

  return { runAllowance, settleForPayment };
}

export type AllowanceService = ReturnType<typeof createAllowanceService>;
