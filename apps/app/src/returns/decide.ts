import { sql, type SQL } from "drizzle-orm";
import { insertReturnApprovedNotice, insertReturnRejectedNotice } from "../contact/notices";
import { batchAtEffectiveNow, effectiveNow } from "../shared/high-water-mark";
import { fail, ok } from "../shared/result";
import type { DecideReturnInput } from "./input";
import type { ReturnStatus } from "./schema";

export type DecideReturnFailure = "return_not_found" | "return_already_decided";

export type DecideReturnResult =
  | { ok: true; data: { requestId: number; decision: "approved" | "rejected"; /** 這次呼叫不是第一次做出這個決定（重送）。 */ replayed: boolean } }
  | { ok: false; reason: DecideReturnFailure };

/** 做出決定之後的進度：核准及其後的所有進度都算「已核准過」，同一決定重送冪等；拒絕只對應拒絕。 */
const APPROVED_OR_LATER: readonly ReturnStatus[] = ["approved", "received", "not_received", "completed"];

/**
 * 管理員審核一案退貨申請（ADR 0006）；單一 batch，是否做成由條件寫入的結果判斷（不先讀再寫）。
 * 拒絕：待審 → 拒絕，數量不再被占用（可再申請）；核准：待審 → 核准，數量仍占用，等待收回。兩者都不動庫存與款項，並與決定同 batch 寫通知。
 * 同一決定重送回 `replayed: true`（核准之後即使已收回或完成，重送核准仍是同一決定）；已做出相反決定回 `return_already_decided`。
 */
export async function decideReturn(d1: D1Database, request: DecideReturnInput & { actor: string }, now: number): Promise<DecideReturnResult> {
  const { requestId, decision, note, actor } = request;
  const target = decision === "approve" ? "approved" : "rejected";
  const statements: SQL[] = [
    sql`
      UPDATE return_requests
      SET status = ${target}, decided_at = ${effectiveNow}, decided_by = ${actor}, decision_note = ${note}
      WHERE id = ${requestId} AND status = 'pending'
    `,
    decision === "approve" ? insertReturnApprovedNotice(requestId) : insertReturnRejectedNotice(requestId),
  ];
  const results = await batchAtEffectiveNow(d1, now, [...statements, sql`SELECT status FROM return_requests WHERE id = ${requestId}`]);

  const changed = results[0]!.meta.changes > 0;
  const found = results[results.length - 1]!.results[0] as { status: ReturnStatus } | undefined;
  if (!found) return fail("return_not_found");
  const sameDecision = decision === "approve" ? APPROVED_OR_LATER.includes(found.status) : found.status === "rejected";
  if (!sameDecision) return fail("return_already_decided");
  return ok({ requestId, decision: target, replayed: !changed });
}
