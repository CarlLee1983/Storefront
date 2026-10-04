import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import rollback0029Sql from "../rollback/0029_shipment_returns.down.sql?raw";
import rollback0028Sql from "../rollback/0028_shipment_losses.down.sql?raw";
import rollback0027Sql from "../rollback/0027_return_batches.down.sql?raw";
import rollbackSql from "../rollback/0026_returns.down.sql?raw";

const db = env.MIGRATION_DB;
const THROUGH_0025 = 26;
const splitStatements = (sql: string) => sql.split("--> statement-breakpoint").map((statement) => db.prepare(statement));
// 回復順序由新到舊：0029（物流退回）先於 0028（確認遺失）先於 0027（批次對應表）先於 0026
const rollbackStatements = () => [...splitStatements(rollback0029Sql), ...splitStatements(rollback0028Sql), ...splitStatements(rollback0027Sql), ...splitStatements(rollbackSql)];
const rows = async (query: string) => (await db.prepare(query).all()).results;

/** 每個測試從空白資料庫開始（遷移會改結構，整個砍掉重來）。 */
beforeEach(async () => {
  const { results } = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'").all<{ name: string }>();
  await db.batch([
    db.prepare("PRAGMA defer_foreign_keys = ON"),
    ...results.map(({ name }) => db.prepare(`DROP TABLE IF EXISTS "${name}"`)),
  ]);
});

/** 0025 結構下已存在的資料：一張訂單與付款、兩筆退款（含嘗試紀錄）、一個變體在庫 7、兩筆庫存流水（調整與交運）。 */
async function seed0025() {
  await applyD1Migrations(db, env.TEST_MIGRATIONS.slice(0, THROUGH_0025));
  await db.batch([
    db.prepare(`INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES ('legacy', 'Legacy', 'legacy@example.test', 1, 0, 0)`),
    db.prepare("INSERT INTO products (id, name, description, listed) VALUES (1, '馬克杯', '', 1)"),
    db.prepare("INSERT INTO product_variants (id, product_id, is_default, price_twd, on_hand) VALUES (1, 1, 1, 100, 7)"),
    db.prepare("INSERT INTO orders (id, customer_id, status, total_twd, shipping_name, shipping_phone, shipping_address, payment_deadline, created_at, idempotency_key, request_hash) VALUES (1, 'legacy', 'shipped', 1000, 'L', '0900000000', 'A', 100, 0, 'key-1', 'hash')"),
    db.prepare("INSERT INTO payments (id, order_id, gateway_payment_id, amount_twd, status, created_at, expires_at) VALUES (1, 1, 'gw_1', 1000, 'succeeded', 10, 99)"),
    db.prepare("INSERT INTO refunds (id, order_id, payment_id, reason, gateway_refund_id, amount_twd, goods_twd, shipping_twd, status, created_at, settled_at) VALUES (1, 1, 1, 'duplicate_success', 'rf_1', 100, 100, 0, 'succeeded', 5, 6), (7, 1, 1, 'cancelled_order', 'rf_7', 200, 200, 0, 'failed', 8, NULL)"),
    db.prepare("INSERT INTO refund_attempts (refund_id, at, actor, action, outcome, code) VALUES (7, 9, 'system', 'send', 'failed', 'refund_failed')"),
    db.prepare("INSERT INTO stock_movements (id, variant_id, kind, delta, on_hand_after, order_id, actor, reason, created_at) VALUES (1, 1, 'adjustment', 10, 10, NULL, 'a@example.test', '補貨', 1), (2, 1, 'dispatch', -3, 7, 1, 'a@example.test', '交運', 2)"),
  ]);
}

it("0026 保留既有退款、庫存與流水（含編號與外鍵），不可售預設為 0，退款新增 return 原因與一案一筆的唯一性", async () => {
  await seed0025();

  await applyD1Migrations(db, env.TEST_MIGRATIONS);

  expect(await rows("SELECT id, reason, status, return_request_id FROM refunds ORDER BY id")).toEqual([
    { id: 1, reason: "duplicate_success", status: "succeeded", return_request_id: null },
    { id: 7, reason: "cancelled_order", status: "failed", return_request_id: null },
  ]);
  expect(await rows("SELECT refund_id, outcome FROM refund_attempts")).toEqual([{ refund_id: 7, outcome: "failed" }]);
  expect(await rows("SELECT on_hand, unavailable FROM product_variants")).toEqual([{ on_hand: 7, unavailable: 0 }]);
  expect(await rows("SELECT id, kind, delta, on_hand_after, unavailable_delta, unavailable_after, return_request_id FROM stock_movements ORDER BY id")).toEqual([
    { id: 1, kind: "adjustment", delta: 10, on_hand_after: 10, unavailable_delta: 0, unavailable_after: 0, return_request_id: null },
    { id: 2, kind: "dispatch", delta: -3, on_hand_after: 7, unavailable_delta: 0, unavailable_after: 0, return_request_id: null },
  ]);
  expect(await rows("PRAGMA foreign_key_check")).toEqual([]);

  await db.prepare("INSERT INTO return_requests (id, order_id, request_key, request_hash, requested_at) VALUES (1, 1, 'k', 'h', 1)").run();
  const insert = (reason: string, id: string) =>
    db.prepare(`INSERT INTO refunds (order_id, payment_id, reason, gateway_refund_id, amount_twd, goods_twd, shipping_twd, status, return_request_id, created_at) VALUES (1, 1, '${reason}', '${id}', 50, 50, 0, 'pending', 1, 0)`);
  await insert("return", "rf_r1").run();
  await expect(insert("return", "rf_r2").run()).rejects.toThrow();
  await expect(insert("something_else", "rf_r3").run()).rejects.toThrow();
  // 新紀錄的編號接在刪過的編號之後，不重用
  expect(await rows("SELECT id FROM refunds WHERE gateway_refund_id = 'rf_r1'")).toEqual([{ id: 8 }]);
  // 庫存流水仍然只增不改不刪
  await expect(db.prepare("UPDATE stock_movements SET reason = 'x'").run()).rejects.toThrow();
  await expect(db.prepare("DELETE FROM stock_movements").run()).rejects.toThrow();
});

it("退貨申請的進度受 CHECK 限制：待審沒有審核時間，完成才有金額，收回狀態一定有收回時間；明細的收到與檢查數量不可超量", async () => {
  await seed0025();
  await applyD1Migrations(db, env.TEST_MIGRATIONS);
  const insert = (columns: string, values: string) => db.prepare(`INSERT INTO return_requests (order_id, request_key, request_hash, requested_at, ${columns}) VALUES (1, 'k${Math.random()}', 'h', 1, ${values})`);

  await insert("status", "'pending'").run();
  await expect(insert("status, decided_at", "'pending', 5").run()).rejects.toThrow();
  await expect(insert("status, decided_at", "'approved', NULL").run()).rejects.toThrow();
  await insert("status, decided_at", "'approved', 5").run();
  await expect(insert("status, decided_at", "'received', 5").run()).rejects.toThrow();
  await insert("status, decided_at, received_at", "'received', 5, 6").run();
  await expect(insert("status, decided_at, received_at", "'completed', 5, 6").run()).rejects.toThrow();
  await insert("status, decided_at, received_at, goods_twd, standard_shipping_twd, large_shipping_twd", "'completed', 5, 6, 100, 0, 0").run();
  await expect(insert("status", "'whatever'").run()).rejects.toThrow();

  await db.prepare("INSERT INTO order_lines (id, order_id, product_id, variant_id, product_name, quantity, unit_price_twd) VALUES (1, 1, 1, 1, 'x', 3, 100)").run();
  const item = (columns: string, values: string) => db.prepare(`INSERT INTO return_request_items (request_id, order_line_id, quantity, ${columns}) VALUES (1, 1, 2, ${values})`);
  await expect(item("received_quantity", "3").run()).rejects.toThrow();
  await expect(item("received_quantity, sellable_quantity, damaged_quantity", "2, 1, 0").run()).rejects.toThrow();
  await expect(item("sellable_quantity", "1").run()).rejects.toThrow();
  await item("received_quantity, sellable_quantity, damaged_quantity", "2, 1, 1").run();
});

it("回復程序移除退貨申請與不可售欄位，refunds 回到 0025 的結構，既有退款與流水原樣保留，之後可重新套用 0026", async () => {
  await seed0025();
  await applyD1Migrations(db, env.TEST_MIGRATIONS);

  await db.batch(rollbackStatements());

  expect(await rows("SELECT name FROM sqlite_master WHERE name LIKE 'return_%'")).toEqual([]);
  expect(await rows("SELECT name FROM pragma_table_info('refunds')")).not.toContainEqual({ name: "return_request_id" });
  expect(await rows("SELECT name FROM pragma_table_info('product_variants')")).not.toContainEqual({ name: "unavailable" });
  expect(await rows("SELECT name FROM pragma_table_info('stock_movements')")).not.toContainEqual({ name: "unavailable_delta" });
  expect(await rows("SELECT id, status FROM refunds ORDER BY id")).toEqual([{ id: 1, status: "succeeded" }, { id: 7, status: "failed" }]);
  expect(await rows("SELECT id, kind FROM stock_movements ORDER BY id")).toEqual([{ id: 1, kind: "adjustment" }, { id: 2, kind: "dispatch" }]);
  expect(await rows("SELECT on_hand FROM product_variants")).toEqual([{ on_hand: 7 }]);
  expect(await rows("PRAGMA foreign_key_check")).toEqual([]);
  await expect(db.prepare("DELETE FROM stock_movements").run()).rejects.toThrow();
  await applyD1Migrations(db, env.TEST_MIGRATIONS);
  expect(await rows("SELECT id FROM refunds ORDER BY id")).toEqual([{ id: 1 }, { id: 7 }]);
});

it("已有退貨申請、不可售數量或不可售流水時，回復的守門檢查讓整段失敗且資料不動", async () => {
  await seed0025();
  await applyD1Migrations(db, env.TEST_MIGRATIONS);
  await db.prepare("UPDATE product_variants SET unavailable = 1 WHERE id = 1").run();

  await expect(db.batch(rollbackStatements())).rejects.toThrow();
  expect(await rows("SELECT name FROM pragma_table_info('product_variants')")).toContainEqual({ name: "unavailable" });

  await db.prepare("UPDATE product_variants SET unavailable = 0 WHERE id = 1").run();
  await db.prepare("INSERT INTO return_requests (order_id, request_key, request_hash, requested_at) VALUES (1, 'k', 'h', 1)").run();
  await expect(db.batch(rollbackStatements())).rejects.toThrow();
  expect(await rows("SELECT count(*) AS n FROM return_requests")).toEqual([{ n: 1 }]);
});

it("0027 的批次對應表：同一申請同明細同批只能一列、數量大於 0；有批次對應時回復被守門檢查擋下，清空後可回復", async () => {
  await seed0025();
  await applyD1Migrations(db, env.TEST_MIGRATIONS);
  await db.batch([
    db.prepare("INSERT INTO order_lines (id, order_id, product_id, variant_id, product_name, quantity, unit_price_twd) VALUES (1, 1, 1, 1, 'x', 3, 100)"),
    db.prepare("INSERT INTO shipments (id, order_id, dispatch_key, actor, delivery_status, delivered_at) VALUES (1, 1, 'k', 'a@example.test', 'delivered', 1000)"),
    db.prepare("INSERT INTO return_requests (id, order_id, request_key, request_hash, requested_at) VALUES (1, 1, 'k', 'h', 1)"),
    db.prepare("INSERT INTO return_request_batches (request_id, order_line_id, shipment_id, quantity) VALUES (1, 1, 1, 2)"),
  ]);
  const insert = (quantity: number) => db.prepare(`INSERT INTO return_request_batches (request_id, order_line_id, shipment_id, quantity) VALUES (1, 1, 1, ${quantity})`);
  await expect(insert(1).run()).rejects.toThrow();
  await db.prepare("INSERT INTO shipments (id, order_id, dispatch_key, actor) VALUES (2, 1, 'k2', 'a@example.test')").run();
  await expect(db.prepare("INSERT INTO return_request_batches (request_id, order_line_id, shipment_id, quantity) VALUES (1, 1, 2, 0)").run()).rejects.toThrow();

  await expect(db.batch(splitStatements(rollback0027Sql))).rejects.toThrow();
  await db.prepare("DELETE FROM return_request_batches").run();
  await db.batch(splitStatements(rollback0027Sql));
  expect(await rows("SELECT name FROM sqlite_master WHERE name LIKE 'return_request_batches%'")).toEqual([]);
  expect(await rows("SELECT id FROM return_requests")).toEqual([{ id: 1 }]);
});
