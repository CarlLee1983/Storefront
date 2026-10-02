import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import rollbackSql from "../rollback/0021_shipments.down.sql?raw";

const db = env.MIGRATION_DB;
const THROUGH_0020 = 21;
const rollbackStatements = () => rollbackSql.split("--> statement-breakpoint").map((statement) => db.prepare(statement));

/** 每個測試從空白資料庫開始（遷移會改結構，整個砍掉重來）。 */
beforeEach(async () => {
  const { results } = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'").all<{ name: string }>();
  await db.batch([
    db.prepare("PRAGMA defer_foreign_keys = ON"),
    ...results.map(({ name }) => db.prepare(`DROP TABLE IF EXISTS "${name}"`)),
  ]);
});

/**
 * 0020 結構下、整單出貨語意的既有資料：訂單 1 已付款、訂單 2 已出貨（有物流單號與出貨時間）、
 * 訂單 3 已出貨但舊紀錄沒有出貨時間與物流單號、訂單 4 待付款；另有一筆已存在的庫存流水與付款，遷移後都必須原樣保留。
 */
async function seedLegacy() {
  await applyD1Migrations(db, env.TEST_MIGRATIONS.slice(0, THROUGH_0020));
  const order = (id: number, status: string, tracking: string | null, shippedAt: number | null) =>
    db.prepare(`INSERT INTO orders (id, customer_id, status, total_twd, shipping_name, shipping_phone, shipping_address, payment_deadline, created_at, idempotency_key, request_hash, tracking_number, shipped_at) VALUES (${id}, 'legacy', '${status}', 100, 'L', '0900000000', 'A', 100, 0, 'key-${id}', 'hash', ?, ?)`).bind(tracking, shippedAt);
  const line = (orderId: number, variantId: number, quantity: number) =>
    db.prepare("INSERT INTO order_lines (order_id, product_id, variant_id, product_name, quantity, unit_price_twd) VALUES (?, ?, ?, 'x', ?, 100)").bind(orderId, variantId, variantId, quantity);
  await db.batch([
    db.prepare(`INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES ('legacy', 'Legacy', 'legacy@example.test', 1, 0, 0)`),
    db.prepare("INSERT INTO products (id, name, description, listed) VALUES (1, '馬克杯', '', 0), (2, '盤子', '', 0)"),
    db.prepare("INSERT INTO product_variants (id, product_id, is_default, price_twd, on_hand) VALUES (1, 1, 1, 100, 20), (2, 2, 1, 100, 6)"),
    order(1, "paid", null, null), order(2, "shipped", "TW123", 1_000), order(3, "shipped", null, null), order(4, "pending_payment", null, null),
    line(1, 1, 2), line(2, 1, 3), line(2, 2, 1), line(3, 1, 1), line(4, 1, 4),
    db.prepare("INSERT INTO payments (id, order_id, gateway_payment_id, amount_twd, status, created_at, expires_at) VALUES (1, 2, 'gw_1', 100, 'succeeded', 0, 1)"),
    db.prepare("INSERT INTO stock_movements (variant_id, kind, delta, on_hand_after, order_id, actor, reason, created_at) VALUES (1, 'dispatch', -3, 20, 2, 'admin@example.com', '交運扣庫', 5)"),
  ]);
}

const rows = async (query: string) => (await db.prepare(query).all()).results;

it("0021 為舊的已出貨訂單補一批整單批次（照搬舊物流單號與出貨時間，沒有的不編造），其餘訂單、付款與流水原樣保留", async () => {
  await seedLegacy();

  await applyD1Migrations(db, env.TEST_MIGRATIONS);

  expect(await rows("SELECT id, status FROM orders ORDER BY id")).toEqual([
    { id: 1, status: "paid" }, { id: 2, status: "shipped" }, { id: 3, status: "shipped" }, { id: 4, status: "pending_payment" },
  ]);
  expect(await rows("SELECT order_id, dispatch_key, tracking_number, appointment_start, appointment_end, shipped_at, actor FROM shipments ORDER BY order_id")).toEqual([
    { order_id: 2, dispatch_key: "legacy:0021", tracking_number: "TW123", appointment_start: null, appointment_end: null, shipped_at: 1_000, actor: "system:0021_shipments" },
    { order_id: 3, dispatch_key: "legacy:0021", tracking_number: null, appointment_start: null, appointment_end: null, shipped_at: null, actor: "system:0021_shipments" },
  ]);
  expect(await rows("SELECT s.order_id, l.variant_id, i.quantity FROM shipment_items i JOIN shipments s ON s.id = i.shipment_id JOIN order_lines l ON l.id = i.order_line_id ORDER BY i.id")).toEqual([
    { order_id: 2, variant_id: 1, quantity: 3 }, { order_id: 2, variant_id: 2, quantity: 1 }, { order_id: 3, variant_id: 1, quantity: 1 },
  ]);
  expect(await rows("SELECT order_id FROM payments")).toEqual([{ order_id: 2 }]);
  expect(await rows("SELECT delta, shipment_id FROM stock_movements")).toEqual([{ delta: -3, shipment_id: null }]);
  expect(await rows("SELECT id, on_hand FROM product_variants ORDER BY id")).toEqual([{ id: 1, on_hand: 20 }, { id: 2, on_hand: 6 }]);
  expect(await rows("PRAGMA foreign_key_check")).toEqual([]);
  expect(await rows("SELECT name FROM pragma_table_info('orders')")).not.toContainEqual({ name: "tracking_number" });
});

it("重建後訂單編號不重用，狀態 CHECK 接受部分出貨", async () => {
  await seedLegacy();
  await db.prepare("DELETE FROM order_lines WHERE order_id = 4").run();
  await db.prepare("DELETE FROM orders WHERE id = 4").run(); // 刪掉最大編號：計數仍要保留

  await applyD1Migrations(db, env.TEST_MIGRATIONS);

  await db.prepare("INSERT INTO orders (customer_id, status, total_twd, shipping_name, shipping_phone, shipping_address, payment_deadline, created_at, idempotency_key, request_hash) VALUES ('legacy', 'partially_shipped', 1, 'L', '0900000000', 'A', 1, 0, 'key-new', 'hash')").run();
  expect(await rows("SELECT MAX(id) AS id FROM orders")).toEqual([{ id: 5 }]);
  await expect(db.prepare("UPDATE orders SET status = 'mystery' WHERE id = 1").run()).rejects.toThrow();
});

it("同一批次的明細數量必須為正、預約時段須成對且結束晚於開始", async () => {
  await seedLegacy();
  await applyD1Migrations(db, env.TEST_MIGRATIONS);

  await expect(db.prepare("INSERT INTO shipment_items (shipment_id, order_line_id, quantity) VALUES (1, 1, 0)").run()).rejects.toThrow();
  await expect(db.prepare("INSERT INTO shipments (order_id, dispatch_key, appointment_start, actor) VALUES (1, 'k1', 10, 'a')").run()).rejects.toThrow();
  await expect(db.prepare("INSERT INTO shipments (order_id, dispatch_key, appointment_start, appointment_end, actor) VALUES (1, 'k2', 10, 10, 'a')").run()).rejects.toThrow();
  await db.prepare("INSERT INTO shipments (order_id, dispatch_key, appointment_start, appointment_end, actor) VALUES (1, 'k3', 10, 20, 'a')").run();
  await expect(db.prepare("INSERT INTO shipments (order_id, dispatch_key, actor) VALUES (1, 'k3', 'a')").run()).rejects.toThrow(); // 同訂單同冪等鍵
});

it("回復程序把補建的整單批次搬回舊欄位、還原狀態 CHECK 與庫存流水，之後可重新套用 0021", async () => {
  await seedLegacy();
  await applyD1Migrations(db, env.TEST_MIGRATIONS);

  await db.batch(rollbackStatements());

  expect(await rows("SELECT id, status, tracking_number, shipped_at FROM orders ORDER BY id")).toEqual([
    { id: 1, status: "paid", tracking_number: null, shipped_at: null },
    { id: 2, status: "shipped", tracking_number: "TW123", shipped_at: 1_000 },
    { id: 3, status: "shipped", tracking_number: null, shipped_at: null },
    { id: 4, status: "pending_payment", tracking_number: null, shipped_at: null },
  ]);
  expect(await rows("SELECT name FROM sqlite_master WHERE name IN ('shipments', 'shipment_items')")).toEqual([]);
  expect(await rows("SELECT name FROM pragma_table_info('stock_movements')")).not.toContainEqual({ name: "shipment_id" });
  expect(await rows("SELECT delta FROM stock_movements")).toEqual([{ delta: -3 }]);
  await expect(db.prepare("UPDATE stock_movements SET delta = 0").run()).rejects.toThrow(); // trigger 仍在
  expect(await rows("PRAGMA foreign_key_check")).toEqual([]);

  await applyD1Migrations(db, env.TEST_MIGRATIONS);
  expect(await rows("SELECT order_id FROM shipments ORDER BY order_id")).toEqual([{ order_id: 2 }, { order_id: 3 }]);
});

it("已有部分出貨或遷移之後才建立的批次時，回復的守門檢查讓整段失敗且資料不動", async () => {
  await seedLegacy();
  await applyD1Migrations(db, env.TEST_MIGRATIONS);
  await db.prepare("INSERT INTO shipments (order_id, dispatch_key, actor) VALUES (1, 'after-migration', 'admin@example.com')").run();

  await expect(db.batch(rollbackStatements())).rejects.toThrow();

  expect(await rows("SELECT order_id, dispatch_key FROM shipments ORDER BY id")).toHaveLength(3);
  expect(await rows("SELECT name FROM pragma_table_info('orders')")).not.toContainEqual({ name: "tracking_number" });

  await db.prepare("DELETE FROM shipments WHERE dispatch_key = 'after-migration'").run();
  await db.prepare("UPDATE orders SET status = 'partially_shipped' WHERE id = 1").run();
  await expect(db.batch(rollbackStatements())).rejects.toThrow();
});
