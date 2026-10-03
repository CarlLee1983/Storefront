import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import rollbackSql from "../rollback/0028_shipment_losses.down.sql?raw";

const db = env.MIGRATION_DB;
const THROUGH_0027 = 28;
const THROUGH_0028 = 29;
/** 0028 之後的遷移（0029 物流退回）不在這個檔案的範圍：套用與回復都只看到 0028。 */
const applyThrough0028 = () => applyD1Migrations(db, env.TEST_MIGRATIONS.slice(0, THROUGH_0028));
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

/** 0027 結構下已存在的資料：一張已出貨訂單、一個批次、兩筆退款（含嘗試紀錄）。 */
async function seed0027() {
  await applyD1Migrations(db, env.TEST_MIGRATIONS.slice(0, THROUGH_0027));
  await db.batch([
    db.prepare(`INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES ('legacy', 'Legacy', 'legacy@example.test', 1, 0, 0)`),
    db.prepare("INSERT INTO products (id, name, description, listed) VALUES (1, '馬克杯', '', 1)"),
    db.prepare("INSERT INTO product_variants (id, product_id, is_default, price_twd, on_hand) VALUES (1, 1, 1, 100, 7)"),
    db.prepare("INSERT INTO orders (id, customer_id, status, total_twd, shipping_name, shipping_phone, shipping_address, payment_deadline, created_at, idempotency_key, request_hash) VALUES (1, 'legacy', 'shipped', 1000, 'L', '0900000000', 'A', 100, 0, 'key-1', 'hash')"),
    db.prepare("INSERT INTO order_lines (id, order_id, product_id, variant_id, product_name, quantity, unit_price_twd) VALUES (1, 1, 1, 1, '馬克杯', 3, 100)"),
    db.prepare("INSERT INTO payments (id, order_id, gateway_payment_id, amount_twd, status, created_at, expires_at) VALUES (1, 1, 'gw_1', 1000, 'succeeded', 10, 99)"),
    db.prepare("INSERT INTO shipments (id, order_id, dispatch_key, actor) VALUES (1, 1, 'k', 'a@example.test')"),
    db.prepare("INSERT INTO shipment_items (shipment_id, order_line_id, quantity) VALUES (1, 1, 3)"),
    db.prepare("INSERT INTO refunds (id, order_id, payment_id, reason, gateway_refund_id, amount_twd, goods_twd, shipping_twd, status, created_at, settled_at) VALUES (1, 1, 1, 'duplicate_success', 'rf_1', 100, 100, 0, 'succeeded', 5, 6), (7, 1, 1, 'cancelled_order', 'rf_7', 200, 200, 0, 'failed', 8, NULL)"),
    db.prepare("INSERT INTO refund_attempts (refund_id, at, actor, action, outcome, code) VALUES (7, 9, 'system', 'send', 'failed', 'refund_failed')"),
  ]);
}

const insertLoss = (key: string) => db.prepare(`INSERT INTO shipment_losses (order_id, shipment_id, loss_key, request_hash, confirmed_at, actor, goods_twd, standard_shipping_twd, large_shipping_twd) VALUES (1, 1, '${key}', 'h', 1, 'a@example.test', 100, 0, 0)`);
const insertLossRefund = (reason: string, gatewayId: string) =>
  db.prepare(`INSERT INTO refunds (order_id, payment_id, reason, gateway_refund_id, amount_twd, goods_twd, shipping_twd, status, shipment_loss_id, created_at) VALUES (1, 1, '${reason}', '${gatewayId}', 100, 100, 0, 'pending', 1, 0)`);

it("0028 保留既有退款與嘗試紀錄（含編號與外鍵），退款新增 loss 原因與一案一筆的唯一性，遺失明細數量須大於 0", async () => {
  await seed0027();

  await applyThrough0028();

  expect(await rows("SELECT id, reason, status, shipment_loss_id FROM refunds ORDER BY id")).toEqual([
    { id: 1, reason: "duplicate_success", status: "succeeded", shipment_loss_id: null },
    { id: 7, reason: "cancelled_order", status: "failed", shipment_loss_id: null },
  ]);
  expect(await rows("SELECT refund_id, outcome FROM refund_attempts")).toEqual([{ refund_id: 7, outcome: "failed" }]);
  expect(await rows("PRAGMA foreign_key_check")).toEqual([]);

  await insertLoss("k1").run();
  await expect(insertLoss("k1").run()).rejects.toThrow();
  await insertLossRefund("loss", "rf_l1").run();
  await expect(insertLossRefund("loss", "rf_l2").run()).rejects.toThrow();
  await expect(insertLossRefund("something_else", "rf_l3").run()).rejects.toThrow();
  // 新紀錄的編號接在刪過的編號之後，不重用
  expect(await rows("SELECT id FROM refunds WHERE gateway_refund_id = 'rf_l1'")).toEqual([{ id: 8 }]);
  await expect(db.prepare("INSERT INTO shipment_loss_items (loss_id, order_line_id, quantity) VALUES (1, 1, 0)").run()).rejects.toThrow();
  await db.prepare("INSERT INTO shipment_loss_items (loss_id, order_line_id, quantity) VALUES (1, 1, 2)").run();
  await expect(db.prepare("INSERT INTO shipment_loss_items (loss_id, order_line_id, quantity) VALUES (1, 1, 1)").run()).rejects.toThrow();
});

it("回復程序移除確認遺失，refunds 回到 0027 的結構，既有退款原樣保留，之後可重新套用 0028", async () => {
  await seed0027();
  await applyThrough0028();

  await db.batch(rollbackStatements());

  expect(await rows("SELECT name FROM sqlite_master WHERE name LIKE 'shipment_loss%'")).toEqual([]);
  expect(await rows("SELECT name FROM pragma_table_info('refunds')")).not.toContainEqual({ name: "shipment_loss_id" });
  expect(await rows("SELECT id, status FROM refunds ORDER BY id")).toEqual([{ id: 1, status: "succeeded" }, { id: 7, status: "failed" }]);
  expect(await rows("SELECT refund_id FROM refund_attempts")).toEqual([{ refund_id: 7 }]);
  expect(await rows("PRAGMA foreign_key_check")).toEqual([]);
  await applyThrough0028();
  expect(await rows("SELECT id FROM refunds ORDER BY id")).toEqual([{ id: 1 }, { id: 7 }]);
});

it("已有確認遺失、遺失退款或遺失進度的批次時，回復的守門檢查讓整段失敗且資料不動", async () => {
  await seed0027();
  await applyThrough0028();
  await insertLoss("k1").run();

  await expect(db.batch(rollbackStatements())).rejects.toThrow();
  expect(await rows("SELECT count(*) AS n FROM shipment_losses")).toEqual([{ n: 1 }]);
  expect(await rows("SELECT name FROM pragma_table_info('refunds')")).toContainEqual({ name: "shipment_loss_id" });

  await db.prepare("DELETE FROM shipment_losses").run();
  await db.prepare("UPDATE shipments SET delivery_status = 'lost' WHERE id = 1").run();
  await expect(db.batch(rollbackStatements())).rejects.toThrow();
  await db.prepare("UPDATE shipments SET delivery_status = 'in_transit' WHERE id = 1").run();
  await db.batch(rollbackStatements());
  expect(await rows("SELECT name FROM sqlite_master WHERE name LIKE 'shipment_loss%'")).toEqual([]);
});
