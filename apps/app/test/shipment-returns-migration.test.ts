import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import rollbackSql from "../rollback/0029_shipment_returns.down.sql?raw";

const db = env.MIGRATION_DB;
const THROUGH_0028 = 29;
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

/** 0028 結構下已存在的資料：一張已出貨訂單、一個批次、一案遺失（含遺失退款）、一筆失敗的退款（含嘗試紀錄）與兩筆庫存流水。 */
async function seed0028() {
  await applyD1Migrations(db, env.TEST_MIGRATIONS.slice(0, THROUGH_0028));
  await db.batch([
    db.prepare(`INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES ('legacy', 'Legacy', 'legacy@example.test', 1, 0, 0)`),
    db.prepare("INSERT INTO products (id, name, description, listed) VALUES (1, '馬克杯', '', 1)"),
    db.prepare("INSERT INTO product_variants (id, product_id, is_default, price_twd, on_hand) VALUES (1, 1, 1, 100, 7)"),
    db.prepare("INSERT INTO orders (id, customer_id, status, total_twd, shipping_name, shipping_phone, shipping_address, payment_deadline, created_at, idempotency_key, request_hash) VALUES (1, 'legacy', 'shipped', 1000, 'L', '0900000000', 'A', 100, 0, 'key-1', 'hash')"),
    db.prepare("INSERT INTO order_lines (id, order_id, product_id, variant_id, product_name, quantity, unit_price_twd) VALUES (1, 1, 1, 1, '馬克杯', 3, 100)"),
    db.prepare("INSERT INTO payments (id, order_id, gateway_payment_id, amount_twd, status, created_at, expires_at) VALUES (1, 1, 'gw_1', 1000, 'succeeded', 10, 99)"),
    db.prepare("INSERT INTO shipments (id, order_id, dispatch_key, actor) VALUES (1, 1, 'k', 'a@example.test')"),
    db.prepare("INSERT INTO shipment_items (shipment_id, order_line_id, quantity) VALUES (1, 1, 3)"),
    db.prepare("INSERT INTO shipment_losses (id, order_id, shipment_id, loss_key, request_hash, confirmed_at, actor, goods_twd, standard_shipping_twd, large_shipping_twd) VALUES (1, 1, 1, 'lk', 'h', 1, 'a@example.test', 100, 0, 0)"),
    db.prepare("INSERT INTO refunds (id, order_id, payment_id, reason, gateway_refund_id, amount_twd, goods_twd, shipping_twd, status, shipment_loss_id, created_at) VALUES (1, 1, 1, 'loss', 'rf_1', 100, 100, 0, 'succeeded', 1, 5), (7, 1, 1, 'cancelled_order', 'rf_7', 200, 200, 0, 'failed', NULL, 8)"),
    db.prepare("INSERT INTO refund_attempts (refund_id, at, actor, action, outcome, code) VALUES (7, 9, 'system', 'send', 'failed', 'refund_failed')"),
    db.prepare("INSERT INTO stock_movements (id, variant_id, kind, delta, on_hand_after, order_id, actor, reason, created_at) VALUES (1, 1, 'adjustment', 10, 10, NULL, 'a@example.test', '補貨', 1), (2, 1, 'dispatch', -3, 7, 1, 'a@example.test', '交運', 2)"),
  ]);
}

const insertReturn = (key: string, status = "returning") =>
  db.prepare(`INSERT INTO shipment_returns (order_id, shipment_id, return_key, request_hash, status, declared_at, actor) VALUES (1, 1, '${key}', 'h', '${status}', 1, 'a@example.test')`);
const insertReturnRefund = (reason: string, gatewayId: string) =>
  db.prepare(`INSERT INTO refunds (order_id, payment_id, reason, gateway_refund_id, amount_twd, goods_twd, shipping_twd, status, shipment_return_id, created_at) VALUES (1, 1, '${reason}', '${gatewayId}', 100, 100, 0, 'pending', 1, 0)`);

it("0029 保留既有退款（含遺失退款）、嘗試紀錄與庫存流水（含編號與外鍵），退款新增 shipment_return 原因與一案一筆的唯一性，流水新增來源欄位", async () => {
  await seed0028();

  await applyD1Migrations(db, env.TEST_MIGRATIONS);

  expect(await rows("SELECT id, reason, status, shipment_loss_id, shipment_return_id FROM refunds ORDER BY id")).toEqual([
    { id: 1, reason: "loss", status: "succeeded", shipment_loss_id: 1, shipment_return_id: null },
    { id: 7, reason: "cancelled_order", status: "failed", shipment_loss_id: null, shipment_return_id: null },
  ]);
  expect(await rows("SELECT refund_id, outcome FROM refund_attempts")).toEqual([{ refund_id: 7, outcome: "failed" }]);
  expect(await rows("SELECT id, kind, shipment_return_id FROM stock_movements ORDER BY id")).toEqual([
    { id: 1, kind: "adjustment", shipment_return_id: null },
    { id: 2, kind: "dispatch", shipment_return_id: null },
  ]);
  expect(await rows("PRAGMA foreign_key_check")).toEqual([]);

  await insertReturn("k1").run();
  await expect(insertReturn("k1").run()).rejects.toThrow();
  await insertReturnRefund("shipment_return", "rf_s1").run();
  await expect(insertReturnRefund("shipment_return", "rf_s2").run()).rejects.toThrow();
  await expect(insertReturnRefund("something_else", "rf_s3").run()).rejects.toThrow();
  // 新紀錄的編號接在既有編號之後，不重用
  expect(await rows("SELECT id FROM refunds WHERE gateway_refund_id = 'rf_s1'")).toEqual([{ id: 8 }]);
  // 進度與明細的資料表約束
  await expect(insertReturn("k2", "completed").run()).rejects.toThrow();
  await expect(db.prepare("INSERT INTO shipment_return_items (return_id, order_line_id, quantity, found_lost_quantity) VALUES (1, 1, 0, 0)").run()).rejects.toThrow();
  await db.prepare("INSERT INTO shipment_return_items (return_id, order_line_id, quantity, found_lost_quantity) VALUES (1, 1, 0, 1)").run();
  await expect(db.prepare("INSERT INTO shipment_return_items (return_id, order_line_id, quantity) VALUES (1, 1, 1)").run()).rejects.toThrow();
  await expect(db.prepare("UPDATE shipment_return_items SET received_quantity = 0, received_found_lost_quantity = 2 WHERE return_id = 1").run()).rejects.toThrow();
});

it("回復程序移除物流退回，refunds 回到 0028 的結構（保留遺失退款），庫存流水保留原有欄位，既有資料原樣保留，之後可重新套用 0029", async () => {
  await seed0028();
  await applyD1Migrations(db, env.TEST_MIGRATIONS);

  await db.batch(rollbackStatements());

  expect(await rows("SELECT name FROM sqlite_master WHERE name LIKE 'shipment_return%'")).toEqual([]);
  expect(await rows("SELECT name FROM pragma_table_info('refunds')")).not.toContainEqual({ name: "shipment_return_id" });
  expect(await rows("SELECT name FROM pragma_table_info('stock_movements')")).not.toContainEqual({ name: "shipment_return_id" });
  expect(await rows("SELECT id, status, shipment_loss_id FROM refunds ORDER BY id")).toEqual([{ id: 1, status: "succeeded", shipment_loss_id: 1 }, { id: 7, status: "failed", shipment_loss_id: null }]);
  expect(await rows("SELECT refund_id FROM refund_attempts")).toEqual([{ refund_id: 7 }]);
  expect(await rows("SELECT id, kind, on_hand_after FROM stock_movements ORDER BY id")).toEqual([{ id: 1, kind: "adjustment", on_hand_after: 10 }, { id: 2, kind: "dispatch", on_hand_after: 7 }]);
  // 庫存流水仍是只增不改不刪
  await expect(db.prepare("UPDATE stock_movements SET delta = 0 WHERE id = 1").run()).rejects.toThrow();
  await expect(db.prepare("DELETE FROM stock_movements WHERE id = 1").run()).rejects.toThrow();
  await expect(db.prepare("INSERT INTO refunds (order_id, payment_id, reason, gateway_refund_id, amount_twd, goods_twd, shipping_twd, status, created_at) VALUES (1, 1, 'shipment_return', 'rf_x', 1, 1, 0, 'pending', 0)").run()).rejects.toThrow();
  expect(await rows("PRAGMA foreign_key_check")).toEqual([]);
  await applyD1Migrations(db, env.TEST_MIGRATIONS);
  expect(await rows("SELECT id FROM refunds ORDER BY id")).toEqual([{ id: 1 }, { id: 7 }]);
});

it("已有物流退回、物流退回退款、物流退回流水或退回進度的批次時，回復的守門檢查讓整段失敗且資料不動", async () => {
  await seed0028();
  await applyD1Migrations(db, env.TEST_MIGRATIONS);
  await insertReturn("k1").run();

  await expect(db.batch(rollbackStatements())).rejects.toThrow();
  expect(await rows("SELECT count(*) AS n FROM shipment_returns")).toEqual([{ n: 1 }]);
  expect(await rows("SELECT name FROM pragma_table_info('refunds')")).toContainEqual({ name: "shipment_return_id" });

  await db.prepare("DELETE FROM shipment_returns").run();
  await db.prepare("UPDATE shipments SET delivery_status = 'returned' WHERE id = 1").run();
  await expect(db.batch(rollbackStatements())).rejects.toThrow();
  await db.prepare("UPDATE shipments SET delivery_status = 'in_transit' WHERE id = 1").run();
  await db.batch(rollbackStatements());
  expect(await rows("SELECT name FROM sqlite_master WHERE name LIKE 'shipment_return%'")).toEqual([]);
});
