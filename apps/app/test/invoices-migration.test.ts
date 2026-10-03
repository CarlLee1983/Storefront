import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import rollbackSql from "../rollback/0030_invoices.down.sql?raw";

const db = env.MIGRATION_DB;
const THROUGH_0029 = 30;
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

/**
 * 0029 結構下已存在的資料：訂單 1 的付款 1 成功（有一筆成功退款 100、一筆失敗退款 200）、付款 2 失敗；
 * 訂單 2 的付款 3 成功（沒有退款）、付款 4 pending。
 */
async function seed0029() {
  await applyD1Migrations(db, env.TEST_MIGRATIONS.slice(0, THROUGH_0029));
  const order = (id: number) =>
    db.prepare(`INSERT INTO orders (id, customer_id, status, total_twd, shipping_name, shipping_phone, shipping_address, payment_deadline, created_at, idempotency_key, request_hash) VALUES (${id}, 'legacy', 'paid', 1000, 'L', '0900000000', 'A', 100, 0, 'key-${id}', 'hash')`);
  const payment = (id: number, orderId: number, status: string, createdAt: number) =>
    db.prepare(`INSERT INTO payments (id, order_id, gateway_payment_id, amount_twd, status, created_at, expires_at) VALUES (${id}, ${orderId}, 'gw_${id}', 1000, '${status}', ${createdAt}, 99)`);
  await db.batch([
    db.prepare(`INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES ('legacy', 'Legacy', 'legacy@example.test', 1, 0, 0)`),
    order(1), order(2),
    payment(1, 1, "succeeded", 10), payment(2, 1, "failed", 11), payment(3, 2, "succeeded", 12), payment(4, 2, "pending", 13),
    db.prepare("INSERT INTO refunds (id, order_id, payment_id, reason, gateway_refund_id, amount_twd, goods_twd, shipping_twd, status, created_at, settled_at) VALUES (1, 1, 1, 'duplicate_success', 'rf_1', 100, 100, 0, 'succeeded', 5, 6), (2, 1, 1, 'cancelled_order', 'rf_2', 200, 200, 0, 'failed', 8, NULL)"),
  ]);
}

it("0030 為遷移前已成功的收款補待開立的發票義務（原額取實收、冪等鍵 inv_legacy_<付款編號>），為已成功的退款補待折讓義務（時間取退款成功時間）；失敗或待付款的收款、未成功的退款不補", async () => {
  await seed0029();

  await applyD1Migrations(db, env.TEST_MIGRATIONS);

  expect(await rows("SELECT order_id, payment_id, gateway_invoice_key, amount_twd, status, invoice_number, created_at, issued_at FROM invoices ORDER BY id")).toEqual([
    { order_id: 1, payment_id: 1, gateway_invoice_key: "inv_legacy_1", amount_twd: 1000, status: "pending", invoice_number: null, created_at: 10, issued_at: null },
    { order_id: 2, payment_id: 3, gateway_invoice_key: "inv_legacy_3", amount_twd: 1000, status: "pending", invoice_number: null, created_at: 12, issued_at: null },
  ]);
  expect(await rows("SELECT refund_id, payment_id, order_id, amount_twd, created_at FROM allowance_obligations ORDER BY id")).toEqual([
    { refund_id: 1, payment_id: 1, order_id: 1, amount_twd: 100, created_at: 6 },
  ]);
  expect(await rows("PRAGMA foreign_key_check")).toEqual([]);
});

it("發票與待折讓義務的唯一性與 CHECK：一筆收款一張發票、一筆退款一個義務，狀態與已開立欄位須一致", async () => {
  await seed0029();
  await applyD1Migrations(db, env.TEST_MIGRATIONS);

  const invoice = (paymentId: number, key: string, status: string, number: string | null, issuedAt: number | null) =>
    db.prepare("INSERT INTO invoices (order_id, payment_id, gateway_invoice_key, amount_twd, status, invoice_number, created_at, issued_at) VALUES (1, ?, ?, 1000, ?, ?, 0, ?)").bind(paymentId, key, status, number, issuedAt);
  await expect(invoice(1, "inv_other", "pending", null, null).run()).rejects.toThrow(); // 付款 1 已有發票
  await expect(invoice(2, "inv_legacy_1", "pending", null, null).run()).rejects.toThrow(); // 冪等鍵唯一
  await expect(invoice(2, "inv_a", "made_up", null, null).run()).rejects.toThrow();
  await expect(invoice(2, "inv_a", "issued", null, null).run()).rejects.toThrow(); // 已開立必須有號碼與時間
  await expect(invoice(2, "inv_a", "pending", "SM-1", 5).run()).rejects.toThrow(); // 未開立不能有號碼
  await invoice(2, "inv_a", "issued", "SM-1", 5).run();
  await expect(db.prepare("INSERT INTO allowance_obligations (refund_id, payment_id, order_id, amount_twd, created_at) VALUES (1, 1, 1, 100, 0)").run()).rejects.toThrow(); // 退款 1 已有義務
  await expect(db.prepare("INSERT INTO allowance_obligations (refund_id, payment_id, order_id, amount_twd, created_at) VALUES (2, 1, 1, 0, 0)").run()).rejects.toThrow();
});

it("回復程序移除發票與待折讓義務，之後可重新套用 0030 並從收款與成功退款補回", async () => {
  await seed0029();
  await applyD1Migrations(db, env.TEST_MIGRATIONS);

  await db.batch(rollbackStatements());

  expect(await rows("SELECT name FROM sqlite_master WHERE name IN ('invoices', 'invoice_attempts', 'allowance_obligations')")).toEqual([]);
  expect(await rows("SELECT name FROM d1_migrations WHERE name = '0030_invoices.sql'")).toEqual([]);
  await applyD1Migrations(db, env.TEST_MIGRATIONS);
  expect(await rows("SELECT payment_id FROM invoices ORDER BY id")).toEqual([{ payment_id: 1 }, { payment_id: 3 }]);
  expect(await rows("SELECT refund_id FROM allowance_obligations")).toEqual([{ refund_id: 1 }]);
});

it("已有已開立的發票時，回復的守門檢查讓整段失敗且資料不動", async () => {
  await seed0029();
  await applyD1Migrations(db, env.TEST_MIGRATIONS);
  await db.prepare("UPDATE invoices SET status = 'issued', invoice_number = 'SM-1', issued_at = 5 WHERE payment_id = 1").run();

  await expect(db.batch(rollbackStatements())).rejects.toThrow();

  expect(await rows("SELECT count(*) AS n FROM invoices")).toEqual([{ n: 2 }]);
  expect(await rows("SELECT count(*) AS n FROM allowance_obligations")).toEqual([{ n: 1 }]);
});

it("有任何開立嘗試紀錄（例如結果不明、發票服務可能已開立）時，回復的守門檢查同樣讓整段失敗", async () => {
  await seed0029();
  await applyD1Migrations(db, env.TEST_MIGRATIONS);
  await db.batch([
    db.prepare("UPDATE invoices SET status = 'unknown' WHERE payment_id = 1"),
    db.prepare("INSERT INTO invoice_attempts (invoice_id, at, actor, action, outcome, code) SELECT id, 1, 'system', 'send', 'unknown', 'unreachable' FROM invoices WHERE payment_id = 1"),
  ]);

  await expect(db.batch(rollbackStatements())).rejects.toThrow();

  expect(await rows("SELECT status FROM invoices WHERE payment_id = 1")).toEqual([{ status: "unknown" }]);
  expect(await rows("SELECT count(*) AS n FROM invoice_attempts")).toEqual([{ n: 1 }]);
});
