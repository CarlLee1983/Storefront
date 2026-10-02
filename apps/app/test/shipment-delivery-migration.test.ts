import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import rollbackSql from "../rollback/0022_shipment_delivery.down.sql?raw";

const db = env.MIGRATION_DB;
const THROUGH_0021 = 22;
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

/** 0021 結構下已存在的兩個批次（一個有出貨時間、一個沒有）。 */
async function seedShipments() {
  await applyD1Migrations(db, env.TEST_MIGRATIONS.slice(0, THROUGH_0021));
  await db.batch([
    db.prepare(`INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES ('legacy', 'Legacy', 'legacy@example.test', 1, 0, 0)`),
    db.prepare("INSERT INTO orders (id, customer_id, status, total_twd, shipping_name, shipping_phone, shipping_address, payment_deadline, created_at, idempotency_key, request_hash) VALUES (1, 'legacy', 'shipped', 100, 'L', '0900000000', 'A', 100, 0, 'key-1', 'hash')"),
    db.prepare("INSERT INTO shipments (id, order_id, dispatch_key, shipped_at, actor) VALUES (1, 1, 'legacy:0021', 1000, 'system:0021_shipments'), (2, 1, 'k2', NULL, 'admin@example.com')"),
  ]);
}

it("0022 讓既有批次成為運送中、沒有送達時間（舊批次沒有可靠送達日，不編造），原欄位原樣保留", async () => {
  await seedShipments();

  await applyD1Migrations(db, env.TEST_MIGRATIONS);

  expect(await rows("SELECT id, dispatch_key, shipped_at, delivery_status, delivered_at FROM shipments ORDER BY id")).toEqual([
    { id: 1, dispatch_key: "legacy:0021", shipped_at: 1000, delivery_status: "in_transit", delivered_at: null },
    { id: 2, dispatch_key: "k2", shipped_at: null, delivery_status: "in_transit", delivered_at: null },
  ]);
  expect(await rows("PRAGMA foreign_key_check")).toEqual([]);
});

it("物流回報的種類受 CHECK 限制，同一批同一事件鍵只能有一筆", async () => {
  await seedShipments();
  await applyD1Migrations(db, env.TEST_MIGRATIONS);

  await db.prepare("INSERT INTO shipment_events (shipment_id, event_key, kind, occurred_at, recorded_at, actor) VALUES (1, 'e1', 'delivered', 5, 6, 'a')").run();
  await expect(db.prepare("INSERT INTO shipment_events (shipment_id, event_key, kind, occurred_at, recorded_at, actor) VALUES (1, 'e1', 'delivered', 5, 6, 'a')").run()).rejects.toThrow();
  await expect(db.prepare("INSERT INTO shipment_events (shipment_id, event_key, kind, occurred_at, recorded_at, actor) VALUES (1, 'e2', 'lost', 5, 6, 'a')").run()).rejects.toThrow();
});

it("回復程序移除送達欄位與事件表，之後可重新套用 0022", async () => {
  await seedShipments();
  await applyD1Migrations(db, env.TEST_MIGRATIONS);

  await db.batch(rollbackStatements());

  expect(await rows("SELECT name FROM sqlite_master WHERE name = 'shipment_events'")).toEqual([]);
  expect(await rows("SELECT name FROM pragma_table_info('shipments')")).not.toContainEqual({ name: "delivery_status" });
  expect(await rows("SELECT id, shipped_at FROM shipments ORDER BY id")).toEqual([{ id: 1, shipped_at: 1000 }, { id: 2, shipped_at: null }]);

  await applyD1Migrations(db, env.TEST_MIGRATIONS);
  expect(await rows("SELECT delivery_status FROM shipments ORDER BY id")).toEqual([{ delivery_status: "in_transit" }, { delivery_status: "in_transit" }]);
});

it("已有物流回報或已送達的批次時，回復的守門檢查讓整段失敗且資料不動", async () => {
  await seedShipments();
  await applyD1Migrations(db, env.TEST_MIGRATIONS);
  await db.prepare("UPDATE shipments SET delivery_status = 'delivered', delivered_at = 9 WHERE id = 1").run();

  await expect(db.batch(rollbackStatements())).rejects.toThrow();
  expect(await rows("SELECT delivery_status, delivered_at FROM shipments WHERE id = 1")).toEqual([{ delivery_status: "delivered", delivered_at: 9 }]);

  await db.prepare("UPDATE shipments SET delivery_status = 'in_transit', delivered_at = NULL WHERE id = 1").run();
  await db.prepare("INSERT INTO shipment_events (shipment_id, event_key, kind, occurred_at, recorded_at, actor) VALUES (1, 'e1', 'delivery_failed', 5, 6, 'a')").run();
  await expect(db.batch(rollbackStatements())).rejects.toThrow();
  expect(await rows("SELECT count(*) AS n FROM shipment_events")).toEqual([{ n: 1 }]);
});
