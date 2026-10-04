import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Clock } from "./clock";
import { failure, success } from "./http";
import { makeDb, type Db } from "./payments";
import { invoiceControls, invoices } from "./schema";

const INVOICE_KEY_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;

const issueInvoiceSchema = z.object({
  invoiceKey: z.string({ error: "invoiceKey 必填" }).regex(INVOICE_KEY_PATTERN, "invoiceKey 只能是 1 至 100 個英數、底線或連字號"),
  merchantReference: z.string({ error: "merchantReference 必填" }).min(1, "merchantReference 必填"),
  amountTwd: z.number({ error: "amountTwd 必須是數字" }).int("amountTwd 必須是整數").positive("amountTwd 必須大於 0"),
});

type InvoiceRow = typeof invoices.$inferSelect;

const invoiceData = (row: InvoiceRow) => ({
  invoiceKey: row.invoiceKey,
  invoiceNumber: row.invoiceNumber,
  merchantReference: row.merchantReference,
  amountTwd: row.amountTwd,
  issuedAt: row.issuedAt,
});

async function findInvoice(db: Db, invoiceKey: string): Promise<InvoiceRow | undefined> {
  return (await db.select().from(invoices).where(eq(invoices.invoiceKey, invoiceKey)).limit(1))[0];
}

/** 旗標用完即清：條件寫在 UPDATE 裡，並行的兩次開立只有一個拿得到。回傳這次是否消耗了旗標。 */
async function takeControl(db: Db, column: "failNext" | "loseNextResponse"): Promise<boolean> {
  const taken = await db
    .update(invoiceControls)
    .set({ [column]: 0 })
    .where(sql`${invoiceControls.id} = 1 AND ${invoiceControls[column]} = 1`)
    .returning({ id: invoiceControls.id });
  return taken.length > 0;
}

/**
 * 開立模擬發票，以 `invoiceKey` 為冪等鍵：同一個鍵重送回同一張發票（已開立的不重複開立），同鍵不同金額或參照回 409。
 * 演練控制（見 `invoiceControls`）：明確失敗不開立（502 `invoice_failed`，可用同一個鍵重試）；回應遺失已開立但回 504 `invoice_timeout`，呼叫端以 `GET /v1/invoices/:invoiceKey` 查證。
 */
export async function issueInvoice(request: Request, env: Env, clock: Clock): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = undefined;
  }
  const parsed = issueInvoiceSchema.safeParse(body);
  if (!parsed.success) {
    const fields: Record<string, string[]> = {};
    for (const issue of parsed.error.issues) (fields[typeof issue.path[0] === "string" ? issue.path[0] : "_form"] ??= []).push(issue.message);
    return failure(400, "invalid_input", "輸入不合法", fields);
  }
  const { invoiceKey, merchantReference, amountTwd } = parsed.data;
  const db = makeDb(env);

  const existing = await findInvoice(db, invoiceKey);
  if (existing) {
    if (existing.amountTwd !== amountTwd || existing.merchantReference !== merchantReference) return failure(409, "invoice_conflict", "這個 invoiceKey 已對應另一張不同的發票");
    return success(invoiceData(existing));
  }
  if (await takeControl(db, "failNext")) return failure(502, "invoice_failed", "模擬的開立發票失敗，可以用同一個 invoiceKey 重試");

  const invoiceNumber = `SM-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  await db.insert(invoices).values({ invoiceKey, merchantReference, amountTwd, invoiceNumber, issuedAt: clock.now() }).onConflictDoNothing();
  const issued = (await findInvoice(db, invoiceKey))!;
  if (issued.amountTwd !== amountTwd || issued.merchantReference !== merchantReference) return failure(409, "invoice_conflict", "這個 invoiceKey 已對應另一張不同的發票");
  if (await takeControl(db, "loseNextResponse")) return failure(504, "invoice_timeout", "模擬的回應遺失：發票可能已開立，請以 invoiceKey 查證");
  return success(invoiceData(issued));
}

/** 查證一張發票；從未收到這個 `invoiceKey` 回 404 `invoice_not_found`。 */
export async function getInvoice(invoiceKey: string, env: Env): Promise<Response> {
  const row = await findInvoice(makeDb(env), invoiceKey);
  return row ? success(invoiceData(row)) : failure(404, "invoice_not_found", "找不到這張發票");
}

/** 主控頁：切換演練旗標（下一次開立失敗、下一次開立回應遺失）。 */
export async function toggleInvoiceControl(env: Env, column: "failNext" | "loseNextResponse"): Promise<void> {
  const db = makeDb(env);
  await db.insert(invoiceControls).values({ id: 1 }).onConflictDoNothing();
  await db
    .update(invoiceControls)
    .set({ [column]: sql`1 - ${invoiceControls[column]}` })
    .where(eq(invoiceControls.id, 1));
}

/** 主控頁顯示用：目前的旗標與最近開立的發票。 */
export async function readInvoiceConsole(env: Env) {
  const db = makeDb(env);
  const [control] = await db.select().from(invoiceControls).where(eq(invoiceControls.id, 1));
  const recent = await db.select().from(invoices).orderBy(sql`${invoices.id} desc`).limit(20);
  return { failNext: control?.failNext === 1, loseNextResponse: control?.loseNextResponse === 1, recent };
}
