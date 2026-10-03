import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import rollbackSql from "../rollback/0031_allowances.down.sql?raw";

const db = env.MIGRATION_DB;
const THROUGH_0030 = 31;
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

/** 0030 結構下已存在的資料：付款 1 成功，兩筆成功退款（100、200）各有一個待折讓義務。 */
async function seed0030() {
  await applyD1Migrations(db, env.TEST_MIGRATIONS.slice(0, THROUGH_0030));
  await db.batch([
    db.prepare(`INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES ('legacy', 'Legacy', 'legacy@example.test', 1, 0, 0)`),
    db.prepare(`INSERT INTO orders (id, customer_id, status, total_twd, shipping_name, shipping_phone, shipping_address, payment_deadline, created_at, idempotency_key, request_hash) VALUES (1, 'legacy', 'paid', 1000, 'L', '0900000000', 'A', 100, 0, 'key-1', 'hash')`),
    db.prepare(`INSERT INTO payments (id, order_id, gateway_payment_id, amount_twd, status, created_at, expires_at) VALUES (1, 1, 'gw_1', 1000, 'succeeded', 10, 99)`),
    db.prepare("INSERT INTO refunds (id, order_id, payment_id, reason, gateway_refund_id, amount_twd, goods_twd, shipping_twd, status, created_at, settled_at) VALUES (1, 1, 1, 'duplicate_success', 'rf_1', 100, 100, 0, 'succeeded', 5, 6), (2, 1, 1, 'cancelled_order', 'rf_2', 200, 200, 0, 'succeeded', 7, 8)"),
    db.prepare("INSERT INTO allowance_obligations (refund_id, payment_id, order_id, amount_twd, created_at) VALUES (1, 1, 1, 100, 6), (2, 1, 1, 200, 8)"),
  ]);
}

it("0031 為 0030 已存在的待折讓義務補冪等鍵 alw_legacy_<義務編號>，狀態維持待折讓，其餘欄位不變", async () => {
  await seed0030();

  await applyD1Migrations(db, env.TEST_MIGRATIONS);

  expect(await rows("SELECT id, refund_id, payment_id, order_id, amount_twd, created_at, gateway_allowance_key, status, allowance_number, issued_at FROM allowance_obligations ORDER BY id")).toEqual([
    { id: 1, refund_id: 1, payment_id: 1, order_id: 1, amount_twd: 100, created_at: 6, gateway_allowance_key: "alw_legacy_1", status: "pending", allowance_number: null, issued_at: null },
    { id: 2, refund_id: 2, payment_id: 1, order_id: 1, amount_twd: 200, created_at: 8, gateway_allowance_key: "alw_legacy_2", status: "pending", allowance_number: null, issued_at: null },
  ]);
  expect(await rows("PRAGMA foreign_key_check")).toEqual([]);
});

it("折讓義務的唯一性與 CHECK：冪等鍵唯一且非空、狀態合法、已折讓必須有號碼與時間；嘗試紀錄的動作與結果受限", async () => {
  await seed0030();
  await applyD1Migrations(db, env.TEST_MIGRATIONS);

  const update = (set: string) => db.prepare(`UPDATE allowance_obligations SET ${set} WHERE id = 1`);
  await expect(update("gateway_allowance_key = 'alw_legacy_2'").run()).rejects.toThrow(); // 冪等鍵唯一
  await expect(update("gateway_allowance_key = ''").run()).rejects.toThrow();
  await expect(update("status = 'made_up'").run()).rejects.toThrow();
  await expect(update("status = 'issued'").run()).rejects.toThrow(); // 已折讓必須有號碼與時間
  await expect(update("allowance_number = 'SA-1', issued_at = 5").run()).rejects.toThrow(); // 未折讓不能有號碼
  await update("status = 'issued', allowance_number = 'SA-1', issued_at = 5").run();
  const attempt = (action: string, outcome: string) => db.prepare("INSERT INTO allowance_attempts (allowance_id, at, actor, action, outcome) VALUES (1, 1, 'system', ?, ?)").bind(action, outcome);
  await expect(attempt("made_up", "succeeded").run()).rejects.toThrow();
  await expect(attempt("send", "made_up").run()).rejects.toThrow();
  await attempt("send", "succeeded").run();
});

it("回復程序把義務還原成 0030 的結構並保留義務本身，之後可重新套用 0031", async () => {
  await seed0030();
  await applyD1Migrations(db, env.TEST_MIGRATIONS);

  await db.batch(rollbackStatements());

  expect(await rows("SELECT name FROM sqlite_master WHERE name IN ('allowance_attempts')")).toEqual([]);
  expect(await rows("SELECT name FROM pragma_table_info('allowance_obligations') ORDER BY cid")).toEqual(
    ["id", "refund_id", "payment_id", "order_id", "amount_twd", "created_at"].map((name) => ({ name })),
  );
  expect(await rows("SELECT refund_id FROM allowance_obligations ORDER BY id")).toEqual([{ refund_id: 1 }, { refund_id: 2 }]);
  expect(await rows("SELECT name FROM d1_migrations WHERE name = '0031_allowances.sql'")).toEqual([]);
  await applyD1Migrations(db, env.TEST_MIGRATIONS);
  expect(await rows("SELECT gateway_allowance_key, status FROM allowance_obligations ORDER BY id")).toEqual([
    { gateway_allowance_key: "alw_legacy_1", status: "pending" },
    { gateway_allowance_key: "alw_legacy_2", status: "pending" },
  ]);
});

it("有已折讓的義務時，回復的守門檢查讓整段失敗且資料不動", async () => {
  await seed0030();
  await applyD1Migrations(db, env.TEST_MIGRATIONS);
  await db.prepare("UPDATE allowance_obligations SET status = 'issued', allowance_number = 'SA-1', issued_at = 5 WHERE id = 1").run();

  await expect(db.batch(rollbackStatements())).rejects.toThrow();

  expect(await rows("SELECT status FROM allowance_obligations ORDER BY id")).toEqual([{ status: "issued" }, { status: "pending" }]);
});

it("有任何折讓嘗試紀錄（例如結果不明、發票服務可能已折讓）時，回復的守門檢查同樣讓整段失敗", async () => {
  await seed0030();
  await applyD1Migrations(db, env.TEST_MIGRATIONS);
  await db.batch([
    db.prepare("UPDATE allowance_obligations SET status = 'unknown' WHERE id = 1"),
    db.prepare("INSERT INTO allowance_attempts (allowance_id, at, actor, action, outcome, code) VALUES (1, 1, 'system', 'send', 'unknown', 'unreachable')"),
  ]);

  await expect(db.batch(rollbackStatements())).rejects.toThrow();

  expect(await rows("SELECT status FROM allowance_obligations WHERE id = 1")).toEqual([{ status: "unknown" }]);
  expect(await rows("SELECT count(*) AS n FROM allowance_attempts")).toEqual([{ n: 1 }]);
});

it("原票已開立、冪等鍵不是 alw_legacy_ 的待折讓義務（折讓可能已在閘道成立卻沒有本地紀錄）也讓回復的守門檢查失敗；舊義務不受影響", async () => {
  await seed0030();
  await applyD1Migrations(db, env.TEST_MIGRATIONS);
  await db.prepare("INSERT INTO invoices (order_id, payment_id, gateway_invoice_key, amount_twd, status, invoice_number, created_at, issued_at) VALUES (1, 1, 'inv_x', 1000, 'issued', 'SM-1', 1, 1)").run();
  await expect(db.batch(rollbackStatements())).resolves.toBeDefined();
  await applyD1Migrations(db, env.TEST_MIGRATIONS);
  await db.prepare("UPDATE allowance_obligations SET gateway_allowance_key = 'alw_new' WHERE id = 1").run();

  await expect(db.batch(rollbackStatements())).rejects.toThrow();

  expect(await rows("SELECT gateway_allowance_key FROM allowance_obligations WHERE id = 1")).toEqual([{ gateway_allowance_key: "alw_new" }]);
});
