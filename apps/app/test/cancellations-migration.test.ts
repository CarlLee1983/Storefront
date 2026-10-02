import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import rollbackSql from "../rollback/0025_cancellations.down.sql?raw";

const db = env.MIGRATION_DB;
const THROUGH_0024 = 25;
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

/** 0024 結構下已存在的退款：一筆成功、一筆明確失敗（含一筆嘗試紀錄），編號不連續（刪過的編號不能被重用）。 */
async function seedRefunds() {
  await applyD1Migrations(db, env.TEST_MIGRATIONS.slice(0, THROUGH_0024));
  await db.batch([
    db.prepare(`INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES ('legacy', 'Legacy', 'legacy@example.test', 1, 0, 0)`),
    db.prepare("INSERT INTO orders (id, customer_id, status, total_twd, shipping_name, shipping_phone, shipping_address, payment_deadline, created_at, idempotency_key, request_hash) VALUES (1, 'legacy', 'paid', 1000, 'L', '0900000000', 'A', 100, 0, 'key-1', 'hash')"),
    db.prepare("INSERT INTO payments (id, order_id, gateway_payment_id, amount_twd, status, created_at, expires_at) VALUES (1, 1, 'gw_1', 1000, 'succeeded', 10, 99)"),
    db.prepare("INSERT INTO refunds (id, order_id, payment_id, reason, gateway_refund_id, amount_twd, goods_twd, shipping_twd, status, created_at, settled_at) VALUES (1, 1, 1, 'duplicate_success', 'rf_1', 100, 100, 0, 'succeeded', 5, 6), (7, 1, 1, 'cancelled_order', 'rf_7', 200, 200, 0, 'failed', 8, NULL)"),
    db.prepare("INSERT INTO refund_attempts (refund_id, at, actor, action, outcome, code) VALUES (7, 9, 'system', 'send', 'failed', 'refund_failed')"),
  ]);
}

it("0025 保留既有退款與嘗試紀錄（含編號與外鍵），新增取消申請的退款原因與一案一筆的唯一性", async () => {
  await seedRefunds();

  await applyD1Migrations(db, env.TEST_MIGRATIONS);

  expect(await rows("SELECT id, reason, status, cancellation_request_id FROM refunds ORDER BY id")).toEqual([
    { id: 1, reason: "duplicate_success", status: "succeeded", cancellation_request_id: null },
    { id: 7, reason: "cancelled_order", status: "failed", cancellation_request_id: null },
  ]);
  expect(await rows("SELECT refund_id, outcome FROM refund_attempts")).toEqual([{ refund_id: 7, outcome: "failed" }]);
  expect(await rows("PRAGMA foreign_key_check")).toEqual([]);

  await db.prepare("INSERT INTO cancellation_requests (id, order_id, request_key, request_hash, requested_at) VALUES (1, 1, 'k', 'h', 1)").run();
  const insert = (reason: string, id: string) =>
    db.prepare(`INSERT INTO refunds (order_id, payment_id, reason, gateway_refund_id, amount_twd, goods_twd, shipping_twd, status, cancellation_request_id, created_at) VALUES (1, 1, '${reason}', '${id}', 50, 50, 0, 'pending', 1, 0)`);
  await insert("cancellation", "rf_c1").run();
  await expect(insert("cancellation", "rf_c2").run()).rejects.toThrow();
  await expect(insert("something_else", "rf_c3").run()).rejects.toThrow();
  // 新紀錄的編號接在刪過的編號之後，不重用
  expect(await rows("SELECT id FROM refunds WHERE gateway_refund_id = 'rf_c1'")).toEqual([{ id: 8 }]);
});

it("取消申請的決定狀態受 CHECK 限制：待審沒有審核時間與金額，核准一定有", async () => {
  await seedRefunds();
  await applyD1Migrations(db, env.TEST_MIGRATIONS);
  const insert = (columns: string, values: string) => db.prepare(`INSERT INTO cancellation_requests (order_id, request_key, request_hash, requested_at, ${columns}) VALUES (1, 'k${Math.random()}', 'h', 1, ${values})`);

  await insert("status", "'pending'").run();
  await expect(insert("status, decided_at", "'pending', 5").run()).rejects.toThrow();
  await expect(insert("status, decided_at", "'approved', 5").run()).rejects.toThrow();
  await insert("status, decided_at, goods_twd, standard_shipping_twd, large_shipping_twd", "'approved', 5, 100, 0, 0").run();
  await insert("status, decided_at", "'rejected', 5").run();
  await expect(insert("status", "'whatever'").run()).rejects.toThrow();
});

it("回復程序移除取消申請並讓 refunds 回到 0024 的結構，既有退款原樣保留，之後可重新套用 0025", async () => {
  await seedRefunds();
  await applyD1Migrations(db, env.TEST_MIGRATIONS);

  await db.batch(rollbackStatements());

  expect(await rows("SELECT name FROM sqlite_master WHERE name LIKE 'cancellation_%'")).toEqual([]);
  expect(await rows("SELECT name FROM pragma_table_info('refunds')")).not.toContainEqual({ name: "cancellation_request_id" });
  expect(await rows("SELECT id, status FROM refunds ORDER BY id")).toEqual([{ id: 1, status: "succeeded" }, { id: 7, status: "failed" }]);
  expect(await rows("SELECT refund_id FROM refund_attempts")).toEqual([{ refund_id: 7 }]);
  expect(await rows("PRAGMA foreign_key_check")).toEqual([]);
  await applyD1Migrations(db, env.TEST_MIGRATIONS);
  expect(await rows("SELECT id FROM refunds ORDER BY id")).toEqual([{ id: 1 }, { id: 7 }]);
});

it("已有取消申請或取消退款時，回復的守門檢查讓整段失敗且資料不動", async () => {
  await seedRefunds();
  await applyD1Migrations(db, env.TEST_MIGRATIONS);
  await db.prepare("INSERT INTO cancellation_requests (order_id, request_key, request_hash, requested_at) VALUES (1, 'k', 'h', 1)").run();

  await expect(db.batch(rollbackStatements())).rejects.toThrow();

  expect(await rows("SELECT count(*) AS n FROM cancellation_requests")).toEqual([{ n: 1 }]);
  expect(await rows("SELECT name FROM pragma_table_info('refunds')")).toContainEqual({ name: "cancellation_request_id" });
});
