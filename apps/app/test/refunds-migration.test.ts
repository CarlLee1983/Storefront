import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import rollbackSql from "../rollback/0024_refunds.down.sql?raw";

const db = env.MIGRATION_DB;
const THROUGH_0023 = 24;
const THROUGH_0024 = 25;
/** 0024 之後的遷移（0030 的待折讓義務外鍵指向 refunds）不在回復測試的範圍：套用與回復都只看到 0024。 */
const applyThrough0024 = () => applyD1Migrations(db, env.TEST_MIGRATIONS.slice(0, THROUGH_0024));
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
 * 0023 結構下、付款上單一退款結果的既有資料：
 * 訂單 1（已逾期，運費 100 + 600）的付款 1 已退款（遲到）；訂單 2（已取消）的付款 2 退款失敗；
 * 訂單 3（已付款）的付款 3 成功、沒有退款；付款 4 是同一張訂單 3 上 pending 的待補查付款（有開著的補查待辦）。
 */
async function seedLegacy() {
  await applyD1Migrations(db, env.TEST_MIGRATIONS.slice(0, THROUGH_0023));
  const order = (id: number, status: string, standard: number, large: number) =>
    db.prepare(`INSERT INTO orders (id, customer_id, status, total_twd, standard_shipping_fee_twd, large_shipping_fee_twd, shipping_name, shipping_phone, shipping_address, payment_deadline, created_at, idempotency_key, request_hash) VALUES (${id}, 'legacy', '${status}', 1000, ${standard}, ${large}, 'L', '0900000000', 'A', 100, 0, 'key-${id}', 'hash')`);
  await db.batch([
    db.prepare(`INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES ('legacy', 'Legacy', 'legacy@example.test', 1, 0, 0)`),
    order(1, "expired", 100, 600), order(2, "cancelled", 0, 0), order(3, "paid", 0, 0),
    db.prepare("INSERT INTO payments (id, order_id, gateway_payment_id, amount_twd, status, created_at, expires_at, refund_reason, refund_at) VALUES (1, 1, 'gw_1', 1000, 'refunded', 10, 99, 'late_success_unreclaimable', 50)"),
    db.prepare("INSERT INTO payments (id, order_id, gateway_payment_id, amount_twd, status, created_at, expires_at, refund_reason, refund_at) VALUES (2, 2, 'gw_2', 1000, 'refund_failed', 20, 99, 'cancelled_order', 60)"),
    db.prepare("INSERT INTO payments (id, order_id, gateway_payment_id, amount_twd, status, created_at, expires_at) VALUES (3, 3, 'gw_3', 1000, 'succeeded', 30, 99)"),
    db.prepare("INSERT INTO payments (id, order_id, gateway_payment_id, amount_twd, status, created_at, expires_at) VALUES (4, 3, 'gw_4', 1000, 'pending', 40, 99)"),
    db.prepare("INSERT INTO payment_reconcile_issues (payment_id, reason, attempts, first_at, last_at, last_source) VALUES (4, 'gateway_unavailable', 1, 1, 1, 'cron')"),
  ]);
}

it("0024 把舊的整筆退款結果搬成逐筆退款（金額取實收並拆成商品款與運費、原因與時間沿用、閘道退款 ID 為 legacy_<閘道付款 ID>），舊的 refund_failed 一律搬成 unknown，付款回到 succeeded，其餘付款與待辦原樣保留", async () => {
  await seedLegacy();

  await applyD1Migrations(db, env.TEST_MIGRATIONS);

  expect(await rows("SELECT order_id, payment_id, reason, gateway_refund_id, amount_twd, goods_twd, shipping_twd, status, created_at, settled_at FROM refunds ORDER BY id")).toEqual([
    { order_id: 1, payment_id: 1, reason: "late_success_unreclaimable", gateway_refund_id: "legacy_gw_1", amount_twd: 1000, goods_twd: 300, shipping_twd: 700, status: "succeeded", created_at: 50, settled_at: 50 },
    { order_id: 2, payment_id: 2, reason: "cancelled_order", gateway_refund_id: "legacy_gw_2", amount_twd: 1000, goods_twd: 1000, shipping_twd: 0, status: "unknown", created_at: 60, settled_at: null },
  ]);
  expect(await rows("SELECT id, order_id, status FROM payments ORDER BY id")).toEqual([
    { id: 1, order_id: 1, status: "succeeded" }, { id: 2, order_id: 2, status: "succeeded" }, { id: 3, order_id: 3, status: "succeeded" }, { id: 4, order_id: 3, status: "pending" },
  ]);
  expect(await rows("SELECT name FROM pragma_table_info('payments')")).not.toContainEqual({ name: "refund_reason" });
  expect(await rows("SELECT payment_id FROM payment_reconcile_issues")).toEqual([{ payment_id: 4 }]);
  expect(await rows("PRAGMA foreign_key_check")).toEqual([]);
});

it("重建後付款編號不重用，付款狀態 CHECK 不再接受 refunded", async () => {
  await seedLegacy();
  await db.prepare("DELETE FROM payment_reconcile_issues").run();
  await db.prepare("DELETE FROM payments WHERE id = 4").run(); // 刪掉最大編號：計數仍要保留

  await applyD1Migrations(db, env.TEST_MIGRATIONS);

  const insert = (status: string) => db.prepare(`INSERT INTO payments (order_id, gateway_payment_id, amount_twd, status, created_at, expires_at) VALUES (3, 'gw_new_${status}', 1, '${status}', 0, 1)`);
  await expect(insert("refunded").run()).rejects.toThrow();
  await insert("succeeded").run();
  expect(await rows("SELECT id FROM payments WHERE gateway_payment_id = 'gw_new_succeeded'")).toEqual([{ id: 5 }]);
});

it("退款的狀態、原因與金額拆分受 CHECK 限制，付款層級原因每個原因一筆付款最多一筆", async () => {
  await seedLegacy();
  await applyD1Migrations(db, env.TEST_MIGRATIONS);

  let sequence = 0;
  const insert = (paymentId: number, reason: string, amount: number, goods: number, shipping: number, status = "pending") =>
    db.prepare("INSERT INTO refunds (order_id, payment_id, reason, gateway_refund_id, amount_twd, goods_twd, shipping_twd, status, created_at) VALUES (3, ?, ?, ?, ?, ?, ?, ?, 0)").bind(paymentId, reason, `rf_t${(sequence += 1)}`, amount, goods, shipping, status);
  await expect(insert(3, "made_up", 10, 10, 0).run()).rejects.toThrow();
  await expect(insert(3, "duplicate_success", 10, 10, 0, "made_up").run()).rejects.toThrow();
  await expect(insert(3, "duplicate_success", 10, 5, 4).run()).rejects.toThrow();
  await expect(insert(3, "duplicate_success", 0, 0, 0).run()).rejects.toThrow();
  await insert(3, "duplicate_success", 10, 10, 0).run();
  await expect(insert(3, "duplicate_success", 10, 10, 0).run()).rejects.toThrow();
});

it("回復程序把逐筆退款寫回付款上的結果，之後可重新套用 0024", async () => {
  await seedLegacy();
  await applyThrough0024();

  await db.batch(rollbackStatements());

  expect(await rows("SELECT id, status, refund_reason, refund_at FROM payments ORDER BY id")).toEqual([
    { id: 1, status: "refunded", refund_reason: "late_success_unreclaimable", refund_at: 50 },
    { id: 2, status: "refund_failed", refund_reason: "cancelled_order", refund_at: 60 },
    { id: 3, status: "succeeded", refund_reason: null, refund_at: null },
    { id: 4, status: "pending", refund_reason: null, refund_at: null },
  ]);
  expect(await rows("SELECT name FROM sqlite_master WHERE name IN ('refunds', 'refund_attempts')")).toEqual([]);
  expect(await rows("PRAGMA foreign_key_check")).toEqual([]);
  await applyThrough0024();
  expect(await rows("SELECT payment_id, status FROM refunds ORDER BY id")).toEqual([{ payment_id: 1, status: "succeeded" }, { payment_id: 2, status: "unknown" }]);
});

it("0024 之後有尚未送出的退款、部分退款或退款嘗試紀錄時，回復的守門檢查讓整段失敗且資料不動", async () => {
  await seedLegacy();
  await applyD1Migrations(db, env.TEST_MIGRATIONS);
  await db.prepare("INSERT INTO refunds (order_id, payment_id, reason, gateway_refund_id, amount_twd, goods_twd, shipping_twd, status, created_at) VALUES (3, 3, 'duplicate_success', 'rf_9', 400, 400, 0, 'pending', 0)").run();

  await expect(db.batch(rollbackStatements())).rejects.toThrow();
  expect(await rows("SELECT count(*) AS n FROM refunds")).toEqual([{ n: 3 }]);
  expect(await rows("SELECT status FROM payments WHERE id = 3")).toEqual([{ status: "succeeded" }]);
  expect(await rows("SELECT name FROM pragma_table_info('payments')")).not.toContainEqual({ name: "refund_reason" });
});
