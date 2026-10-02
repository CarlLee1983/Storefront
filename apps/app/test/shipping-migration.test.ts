import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import rollbackSql from "../rollback/0019_shipping_fees.down.sql?raw";

const db = env.MIGRATION_DB;
const THROUGH_0018 = 19;

/** 每個測試從空白資料庫開始（遷移會改結構，整個砍掉重來）。 */
beforeEach(async () => {
  const { results } = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'").all<{ name: string }>();
  await db.batch([
    db.prepare("PRAGMA defer_foreign_keys = ON"),
    ...results.map(({ name }) => db.prepare(`DROP TABLE IF EXISTS "${name}"`)),
  ]);
});

/** 0018 結構下的既有資料：一張免運的已付款舊單（總額 640 = 2 × 320）。 */
async function seedThrough0018() {
  await applyD1Migrations(db, env.TEST_MIGRATIONS.slice(0, THROUGH_0018));
  await db.batch([
    db.prepare(`INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES ('legacy', 'Legacy', 'legacy@example.test', 1, 0, 0)`),
    db.prepare("INSERT INTO products (id, name, description, listed) VALUES (1, '馬克杯', '', 0)"),
    db.prepare("INSERT INTO product_variants (id, product_id, is_default, price_twd, on_hand) VALUES (1, 1, 1, 320, 4)"),
    db.prepare(`INSERT INTO orders (id, customer_id, status, total_twd, shipping_name, shipping_phone, shipping_address, payment_deadline, created_at, idempotency_key, request_hash) VALUES (1, 'legacy', 'paid', 640, 'L', '0900000000', 'A', 100, 0, 'key-1', 'hash')`),
    db.prepare("INSERT INTO order_lines (order_id, product_id, variant_id, product_name, quantity, unit_price_twd) VALUES (1, 1, 1, '馬克杯', 2, 320)"),
  ]);
}

const columns = async (table: string) => (await db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all<{ name: string }>()).results.map(({ name }) => name);

it("0019 讓既有變體與訂單明細為一般宅配、既有訂單運費為 0，舊單金額與免運不變，並寫入初始費率", async () => {
  await seedThrough0018();

  await applyD1Migrations(db, env.TEST_MIGRATIONS);

  expect(await db.prepare("SELECT delivery_type FROM product_variants WHERE id = 1").first()).toEqual({ delivery_type: "standard" });
  expect(await db.prepare("SELECT delivery_type FROM order_lines WHERE order_id = 1").first()).toEqual({ delivery_type: "standard" });
  expect(await db.prepare("SELECT total_twd, standard_shipping_fee_twd, large_shipping_fee_twd FROM orders WHERE id = 1").first())
    .toEqual({ total_twd: 640, standard_shipping_fee_twd: 0, large_shipping_fee_twd: 0 });
  expect((await db.prepare("SELECT delivery_type, fee_twd FROM shipping_rates ORDER BY delivery_type").all()).results)
    .toEqual([{ delivery_type: "large", fee_twd: 600 }, { delivery_type: "standard", fee_twd: 100 }]);
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
});

it("費率表只接受已知類型與非負金額", async () => {
  await applyD1Migrations(db, env.TEST_MIGRATIONS);

  await expect(db.prepare("INSERT INTO shipping_rates (delivery_type, fee_twd) VALUES ('express', 10)").run()).rejects.toThrow();
  await expect(db.prepare("UPDATE shipping_rates SET fee_twd = -1 WHERE delivery_type = 'standard'").run()).rejects.toThrow();
});

it("沒有使用任何新功能時，回復程序移除新欄位與費率表並可重新套用 0019，舊單不變", async () => {
  await seedThrough0018();
  await applyD1Migrations(db, env.TEST_MIGRATIONS);

  for (const statement of rollbackSql.split("--> statement-breakpoint")) await db.prepare(statement).run();

  expect(await columns("product_variants")).not.toContain("delivery_type");
  expect(await columns("order_lines")).not.toContain("delivery_type");
  expect(await columns("orders")).not.toContain("standard_shipping_fee_twd");
  expect((await db.prepare("SELECT name FROM sqlite_master WHERE name = 'shipping_rates'").all()).results).toEqual([]);
  expect(await db.prepare("SELECT total_twd FROM orders WHERE id = 1").first()).toEqual({ total_twd: 640 });

  await applyD1Migrations(db, env.TEST_MIGRATIONS);
  expect(await columns("orders")).toContain("large_shipping_fee_twd");
});

it.each([
  ["訂單收過運費", "UPDATE orders SET standard_shipping_fee_twd = 100 WHERE id = 1"],
  ["變體是大型配送", "UPDATE product_variants SET delivery_type = 'large' WHERE id = 1"],
  ["訂單明細是大型配送", "UPDATE order_lines SET delivery_type = 'large' WHERE order_id = 1"],
])("%s時回復程序拒絕執行，不破壞資料", async (_label, mutation) => {
  await seedThrough0018();
  await applyD1Migrations(db, env.TEST_MIGRATIONS);
  await db.prepare(mutation).run();

  const [dropGuard, createGuard, check] = rollbackSql.split("--> statement-breakpoint");
  await db.prepare(dropGuard!).run();
  await db.prepare(createGuard!).run();
  await expect(db.prepare(check!).run()).rejects.toThrow();

  expect(await columns("orders")).toContain("standard_shipping_fee_twd");
});
