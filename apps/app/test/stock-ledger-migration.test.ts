import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import rollbackSql from "../rollback/0020_stock_ledger.down.sql?raw";
import verifySql from "../scripts/verify-0020-stock.sql?raw";

const db = env.MIGRATION_DB;
const THROUGH_0019 = 20;

/** 每個測試從空白資料庫開始（遷移會改結構，整個砍掉重來）。 */
beforeEach(async () => {
  const { results } = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'").all<{ name: string }>();
  await db.batch([
    db.prepare("PRAGMA defer_foreign_keys = ON"),
    ...results.map(({ name }) => db.prepare(`DROP TABLE IF EXISTS "${name}"`)),
  ]);
});

/**
 * 0019 結構下、付款扣庫語意的既有資料。實際倉內：馬克杯 12 件、盤子 6 件。
 * 馬克杯：已付未出貨 2 + 3（兩張單）、已出貨 1（已離倉）、待付款 4；在庫數（已扣已付款）= 12 − 5 = 7（已出貨那件早已不在 12 裡，故倉內為 7 + 5 = 12）。
 * 盤子：沒有任何已付款訂單，在庫 6。
 */
async function seedLegacy() {
  await applyD1Migrations(db, env.TEST_MIGRATIONS.slice(0, THROUGH_0019));
  const order = (id: number, status: string, paidBy: number | null) =>
    db.prepare(`INSERT INTO orders (id, customer_id, status, total_twd, shipping_name, shipping_phone, shipping_address, payment_deadline, created_at, idempotency_key, request_hash, paid_by_payment_id) VALUES (${id}, 'legacy', '${status}', 100, 'L', '0900000000', 'A', 100, 0, 'key-${id}', 'hash', ${paidBy})`);
  const line = (orderId: number, variantId: number, quantity: number) =>
    db.prepare("INSERT INTO order_lines (order_id, product_id, variant_id, product_name, quantity, unit_price_twd) VALUES (?, ?, ?, 'x', ?, 100)").bind(orderId, variantId, variantId, quantity);
  const payment = (id: number, orderId: number, status: string) =>
    db.prepare("INSERT INTO payments (id, order_id, gateway_payment_id, amount_twd, status, created_at, expires_at) VALUES (?, ?, ?, 100, ?, 0, 1)").bind(id, orderId, `gw_${id}`, status);
  await db.batch([
    db.prepare(`INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES ('legacy', 'Legacy', 'legacy@example.test', 1, 0, 0)`),
    db.prepare("INSERT INTO products (id, name, description, listed) VALUES (1, '馬克杯', '', 0), (2, '盤子', '', 0)"),
    db.prepare("INSERT INTO product_variants (id, product_id, is_default, price_twd, on_hand) VALUES (1, 1, 1, 100, 7), (2, 2, 1, 100, 6)"),
    order(1, "paid", 1), order(2, "paid", 2), order(3, "shipped", 3), order(4, "pending_payment", null), order(5, "cancelled", null),
    payment(1, 1, "succeeded"), payment(2, 2, "succeeded"), payment(3, 3, "succeeded"),
    line(1, 1, 2), line(2, 1, 3), line(3, 1, 1), line(4, 1, 4), line(5, 1, 9),
  ]);
}

const onHandOf = async (variantId: number) => (await db.prepare("SELECT on_hand FROM product_variants WHERE id = ?").bind(variantId).first<{ on_hand: number }>())!.on_hand;

/** 可售數量（新語意）：在庫數 − 待付款與已付款保留。 */
const availableOf = async (variantId: number) =>
  (await db.prepare(`
    SELECT on_hand - COALESCE((
      SELECT SUM(l.quantity) FROM order_lines l JOIN orders o ON o.id = l.order_id
      WHERE l.variant_id = variant.id AND o.status IN ('pending_payment', 'paid')
    ), 0) AS available FROM product_variants variant WHERE id = ?`).bind(variantId).first<{ available: number }>())!.available;

async function verifyExceptions() {
  const exceptions: unknown[] = [];
  for (const statement of verifySql.split(";").filter((chunk) => chunk.replace(/--.*$/gm, "").trim() !== "")) {
    exceptions.push(...(await db.prepare(statement).all()).results);
  }
  return exceptions;
}

it("0020 把舊已付未出貨加回在庫數並建立已付款保留，已出貨不加回，可售數量不變", async () => {
  await seedLegacy();
  const oldAvailable = 7 - 4; // 舊語意：在庫數 − 待付款保留

  await applyD1Migrations(db, env.TEST_MIGRATIONS);

  expect(await onHandOf(1)).toBe(12); // 7 + 2 + 3；已出貨的 1 件不加回
  expect(await onHandOf(2)).toBe(6);
  expect(await availableOf(1)).toBe(oldAvailable);
  expect((await db.prepare("SELECT variant_id, kind, delta, on_hand_after, order_id, actor, created_at FROM stock_movements ORDER BY id").all()).results).toEqual([
    { variant_id: 1, kind: "migration", delta: 2, on_hand_after: 9, order_id: 1, actor: "system:0020_stock_ledger", created_at: expect.any(Number) },
    { variant_id: 1, kind: "migration", delta: 3, on_hand_after: 12, order_id: 2, actor: "system:0020_stock_ledger", created_at: expect.any(Number) },
  ]);
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  expect(await verifyExceptions()).toEqual([]);
});

it("沒有已付款訂單時 0020 不動在庫數也不寫流水", async () => {
  await applyD1Migrations(db, env.TEST_MIGRATIONS.slice(0, THROUGH_0019));
  await db.prepare("INSERT INTO products (id, name, description, listed) VALUES (1, '馬克杯', '', 0)").run();
  await db.prepare("INSERT INTO product_variants (id, product_id, is_default, price_twd, on_hand) VALUES (1, 1, 1, 100, 5)").run();

  await applyD1Migrations(db, env.TEST_MIGRATIONS);

  expect(await onHandOf(1)).toBe(5);
  expect((await db.prepare("SELECT COUNT(*) AS n FROM stock_movements").first<{ n: number }>())!.n).toBe(0);
});

it("核對腳本列出例外：已付款卻沒有成功付款、可售為負、流水與在庫數對不上", async () => {
  await seedLegacy();
  await db.prepare("DELETE FROM payments WHERE id = 2").run(); // 訂單 2 已付款卻沒有付款紀錄
  await applyD1Migrations(db, env.TEST_MIGRATIONS);
  await db.prepare("UPDATE product_variants SET on_hand = 2 WHERE id = 1").run(); // 手動改庫存：保留 9，可售 −7，且與流水不符

  const exceptions = await verifyExceptions();

  expect(exceptions).toEqual(expect.arrayContaining([
    { exception: "paid_without_succeeded_payment", order_id: 2, variant_id: null },
    { exception: "negative_available", order_id: null, variant_id: 1 },
    { exception: "ledger_mismatch", order_id: null, variant_id: 1 },
  ]));
});

it("回復程序把已付款訂單的數量扣回在庫數（回到付款扣庫語意）、移除流水，並可重新套用 0020", async () => {
  await seedLegacy();
  await applyD1Migrations(db, env.TEST_MIGRATIONS);

  for (const statement of rollbackSql.split("--> statement-breakpoint")) await db.prepare(statement).run();

  expect(await onHandOf(1)).toBe(7);
  expect(await onHandOf(2)).toBe(6);
  expect((await db.prepare("SELECT name FROM sqlite_master WHERE name = 'stock_movements'").all()).results).toEqual([]);

  await applyD1Migrations(db, env.TEST_MIGRATIONS);
  expect(await onHandOf(1)).toBe(12);
});

it("遷移後才付款（未交運）的訂單，回復時也一併扣回", async () => {
  await seedLegacy();
  await applyD1Migrations(db, env.TEST_MIGRATIONS);
  await db.prepare("UPDATE orders SET status = 'paid' WHERE id = 4").run(); // 新語意下付款不扣庫

  for (const statement of rollbackSql.split("--> statement-breakpoint")) await db.prepare(statement).run();

  expect(await onHandOf(1)).toBe(3); // 12 − 2 − 3 − 4
});

it("流水裡有遷移以外的紀錄，或扣回後會變負數時，回復的守門檢查讓整段失敗且資料不動", async () => {
  await seedLegacy();
  await applyD1Migrations(db, env.TEST_MIGRATIONS);
  const [dropGuard, createGuard, check] = rollbackSql.split("--> statement-breakpoint");

  await db.prepare("INSERT INTO stock_movements (variant_id, kind, delta, on_hand_after, actor, reason, created_at) VALUES (1, 'adjustment', 1, 13, 'a@example.test', '補貨', 0)").run();
  await expect(db.prepare("UPDATE stock_movements SET delta = 99").run()).rejects.toThrow(/append-only/);
  await expect(db.prepare("DELETE FROM stock_movements").run()).rejects.toThrow(/append-only/);
  await db.prepare("UPDATE product_variants SET on_hand = 13 WHERE id = 1").run();
  await db.prepare(dropGuard!).run();
  await db.prepare(createGuard!).run();
  await expect(db.prepare(check!).run()).rejects.toThrow();
  expect(await onHandOf(1)).toBe(13);

  await db.prepare("DROP TABLE rollback_guard").run();
  await db.prepare("DROP TRIGGER stock_movements_no_delete").run(); // 只為安排前置狀態；正式資料不會被刪
  await db.prepare("DELETE FROM stock_movements WHERE kind = 'adjustment'").run();
  await db.prepare("UPDATE product_variants SET on_hand = 4 WHERE id = 1").run(); // 低於已付款的 5 件
  await db.prepare(dropGuard!).run();
  await db.prepare(createGuard!).run();
  await expect(db.prepare(check!).run()).rejects.toThrow();
  expect(await onHandOf(1)).toBe(4);
});
