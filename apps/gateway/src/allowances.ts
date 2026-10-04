import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Clock } from "./clock";
import { failure, success } from "./http";
import { makeDb, type Db } from "./payments";
import { allowanceControls, allowances, invoices } from "./schema";

const KEY_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;

const issueAllowanceSchema = z.object({
  allowanceKey: z.string({ error: "allowanceKey 必填" }).regex(KEY_PATTERN, "allowanceKey 只能是 1 至 100 個英數、底線或連字號"),
  amountTwd: z.number({ error: "amountTwd 必須是數字" }).int("amountTwd 必須是整數").positive("amountTwd 必須大於 0"),
});

type AllowanceRow = typeof allowances.$inferSelect;

const allowanceData = (row: AllowanceRow) => ({
  allowanceKey: row.allowanceKey,
  invoiceKey: row.invoiceKey,
  allowanceNumber: row.allowanceNumber,
  amountTwd: row.amountTwd,
  issuedAt: row.issuedAt,
});

async function findAllowance(db: Db, allowanceKey: string): Promise<AllowanceRow | undefined> {
  return (await db.select().from(allowances).where(eq(allowances.allowanceKey, allowanceKey)).limit(1))[0];
}

/** 旗標用完即清：條件寫在 UPDATE 裡，並行的兩次折讓只有一個拿得到。回傳這次是否消耗了旗標。 */
async function takeControl(db: Db, column: "failNext" | "loseNextResponse"): Promise<boolean> {
  const taken = await db
    .update(allowanceControls)
    .set({ [column]: 0 })
    .where(sql`${allowanceControls.id} = 1 AND ${allowanceControls[column]} = 1`)
    .returning({ id: allowanceControls.id });
  return taken.length > 0;
}

const conflict = () => failure(409, "allowance_conflict", "這個 allowanceKey 已對應另一張不同的折讓");

/**
 * 對一張已開立的發票開立折讓，以 `allowanceKey` 為冪等鍵：同一個鍵重送回同一張折讓，同鍵不同金額或不同發票回 409 `allowance_conflict`。
 * 發票不存在回 404 `invoice_not_found`（不產生無原票的折讓）；累計折讓加這一筆超過發票原額回 422 `allowance_exceeds_invoice`。
 * 演練控制（見 `allowanceControls`）：明確失敗不折讓（502 `allowance_failed`，可用同一個鍵重試）；回應遺失已折讓但回 504 `allowance_timeout`，呼叫端以 `GET /v1/allowances/:allowanceKey` 查證。
 */
export async function issueAllowance(invoiceKey: string, request: Request, env: Env, clock: Clock): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = undefined;
  }
  const parsed = issueAllowanceSchema.safeParse(body);
  if (!parsed.success) {
    const fields: Record<string, string[]> = {};
    for (const issue of parsed.error.issues) (fields[typeof issue.path[0] === "string" ? issue.path[0] : "_form"] ??= []).push(issue.message);
    return failure(400, "invalid_input", "輸入不合法", fields);
  }
  const { allowanceKey, amountTwd } = parsed.data;
  const db = makeDb(env);

  const existing = await findAllowance(db, allowanceKey);
  if (existing) return existing.invoiceKey === invoiceKey && existing.amountTwd === amountTwd ? success(allowanceData(existing)) : conflict();

  const invoice = (await db.select().from(invoices).where(eq(invoices.invoiceKey, invoiceKey)).limit(1))[0];
  if (!invoice) return failure(404, "invoice_not_found", "找不到這張發票，不能對不存在的發票折讓");
  if (await takeControl(db, "failNext")) return failure(502, "allowance_failed", "模擬的折讓失敗，可以用同一個 allowanceKey 重試");

  // 額度檢查與寫入同一句 SQL：並行的折讓不會合起來超過原額
  const allowanceNumber = `SA-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  const inserted = await db.run(sql`
    INSERT INTO allowances (allowance_key, invoice_key, amount_twd, allowance_number, issued_at)
    SELECT ${allowanceKey}, ${invoiceKey}, ${amountTwd}, ${allowanceNumber}, ${clock.now()}
    WHERE (SELECT COALESCE(SUM(amount_twd), 0) FROM allowances WHERE invoice_key = ${invoiceKey}) + ${amountTwd} <= ${invoice.amountTwd}
    ON CONFLICT (allowance_key) DO NOTHING
  `);
  const issued = await findAllowance(db, allowanceKey);
  if (!issued) {
    if (inserted.meta.changes === 0) return failure(422, "allowance_exceeds_invoice", "累計折讓不得超過發票原額");
    return failure(500, "internal_error", "折讓寫入失敗");
  }
  if (issued.invoiceKey !== invoiceKey || issued.amountTwd !== amountTwd) return conflict();
  if (await takeControl(db, "loseNextResponse")) return failure(504, "allowance_timeout", "模擬的回應遺失：折讓可能已開立，請以 allowanceKey 查證");
  return success(allowanceData(issued));
}

/** 查證一張折讓；從未收到這個 `allowanceKey` 回 404 `allowance_not_found`。 */
export async function getAllowance(allowanceKey: string, env: Env): Promise<Response> {
  const row = await findAllowance(makeDb(env), allowanceKey);
  return row ? success(allowanceData(row)) : failure(404, "allowance_not_found", "找不到這張折讓");
}

/** 主控頁：切換演練旗標（下一次折讓失敗、下一次折讓回應遺失）。 */
export async function toggleAllowanceControl(env: Env, column: "failNext" | "loseNextResponse"): Promise<void> {
  const db = makeDb(env);
  await db.insert(allowanceControls).values({ id: 1 }).onConflictDoNothing();
  await db
    .update(allowanceControls)
    .set({ [column]: sql`1 - ${allowanceControls[column]}` })
    .where(eq(allowanceControls.id, 1));
}

/** 主控頁顯示用：目前的旗標與最近開立的折讓。 */
export async function readAllowanceConsole(env: Env) {
  const db = makeDb(env);
  const [control] = await db.select().from(allowanceControls).where(eq(allowanceControls.id, 1));
  const recent = await db.select().from(allowances).orderBy(sql`${allowances.id} desc`).limit(20);
  return { failNext: control?.failNext === 1, loseNextResponse: control?.loseNextResponse === 1, recent };
}
