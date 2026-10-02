import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import rollbackSql from "../rollback/0023_payment_reconcile.down.sql?raw";

const db = env.MIGRATION_DB;
const rollbackStatements = () => rollbackSql.split("--> statement-breakpoint").map((statement) => db.prepare(statement));
const rows = async (query: string) => (await db.prepare(query).all()).results;

/** 每個測試從空白資料庫開始（遷移會改結構，整個砍掉重來）。 */
beforeEach(async () => {
  const { results } = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'").all<{ name: string }>();
  await db.batch([
    db.prepare("PRAGMA defer_foreign_keys = ON"),
    ...results.map(({ name }) => db.prepare(`DROP TABLE IF EXISTS "${name}"`)),
  ]);
});

/** 套用全部遷移，並安排一筆 pending 付款（編號 1）。 */
async function seedPayment() {
  await applyD1Migrations(db, env.TEST_MIGRATIONS);
  await db.batch([
    db.prepare(`INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES ('c', 'C', 'c@example.test', 1, 0, 0)`),
    db.prepare("INSERT INTO orders (id, customer_id, status, total_twd, shipping_name, shipping_phone, shipping_address, payment_deadline, created_at, idempotency_key, request_hash) VALUES (1, 'c', 'pending_payment', 100, 'C', '0900000000', 'A', 100, 0, 'key-1', 'hash')"),
    db.prepare("INSERT INTO payments (id, order_id, gateway_payment_id, amount_twd, status, created_at, expires_at) VALUES (1, 1, 'pay_1', 100, 'pending', 0, 100)"),
  ]);
}

const insertIssue = (reason: string) =>
  db.prepare("INSERT INTO payment_reconcile_issues (payment_id, reason, attempts, first_at, last_at, last_source) VALUES (1, ?, 1, 1, 1, 'cron')").bind(reason);

it("待辦的原因受 CHECK 限制，每筆付款只有一列", async () => {
  await seedPayment();

  await insertIssue("gateway_unavailable").run();
  await expect(insertIssue("gateway_unavailable").run()).rejects.toThrow();
  await db.prepare("DELETE FROM payment_reconcile_issues").run();
  await expect(insertIssue("made_up").run()).rejects.toThrow();
});

it("回復程序移除待辦表，付款不受影響，之後可重新套用 0023", async () => {
  await seedPayment();

  await db.batch(rollbackStatements());

  expect(await rows("SELECT name FROM sqlite_master WHERE name = 'payment_reconcile_issues'")).toEqual([]);
  expect(await rows("SELECT id, status FROM payments")).toEqual([{ id: 1, status: "pending" }]);
  await applyD1Migrations(db, env.TEST_MIGRATIONS);
  expect(await rows("SELECT name FROM sqlite_master WHERE name = 'payment_reconcile_issues'")).toHaveLength(1);
});

it("還有開著的待辦時，回復的守門檢查讓整段失敗且資料不動；已解決的不擋", async () => {
  await seedPayment();
  await insertIssue("result_unclear").run();

  await expect(db.batch(rollbackStatements())).rejects.toThrow();
  expect(await rows("SELECT count(*) AS n FROM payment_reconcile_issues")).toEqual([{ n: 1 }]);

  await db.prepare("UPDATE payment_reconcile_issues SET resolved_at = 5").run();
  await db.batch(rollbackStatements());
  expect(await rows("SELECT name FROM sqlite_master WHERE name = 'payment_reconcile_issues'")).toEqual([]);
});
