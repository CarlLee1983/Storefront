import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import rollbackSql from "../rollback/0014_variant_options.down.sql?raw";
import rollback0026Sql from "../rollback/0026_returns.down.sql?raw";
import rollback0021Sql from "../rollback/0021_shipments.down.sql?raw";
import rollback0020Sql from "../rollback/0020_stock_ledger.down.sql?raw";
import rollback0019Sql from "../rollback/0019_shipping_fees.down.sql?raw";

const db = env.MIGRATION_DB;
const THROUGH_0013 = 14;

/** 每個測試從空白資料庫開始（遷移會改結構，整個砍掉重來）。 */
beforeEach(async () => {
  const { results } = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'").all<{ name: string }>();
  await db.batch([
    db.prepare("PRAGMA defer_foreign_keys = ON"),
    ...results.map(({ name }) => db.prepare(`DROP TABLE IF EXISTS "${name}"`)),
  ]);
});

/** 0013 結構下的既有資料：一個商品、它的預設變體，以及一張已成立的訂單明細。 */
async function seedThrough0013() {
  await applyD1Migrations(db, env.TEST_MIGRATIONS.slice(0, THROUGH_0013));
  await db.batch([
    db.prepare(`INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES ('legacy', 'Legacy', 'legacy@example.test', 1, 0, 0)`),
    db.prepare("INSERT INTO products (id, name, description, listed) VALUES (1, '馬克杯', '', 0)"),
    db.prepare("INSERT INTO product_variants (id, product_id, is_default, price_twd, on_hand) VALUES (1, 1, 1, 320, 4)"),
    db.prepare(`INSERT INTO orders (id, customer_id, status, total_twd, shipping_name, shipping_phone, shipping_address, payment_deadline, created_at, idempotency_key, request_hash) VALUES (1, 'legacy', 'paid', 640, 'L', '0900000000', 'A', 100, 0, 'key-1', 'hash')`),
    db.prepare("INSERT INTO order_lines (order_id, product_id, variant_id, product_name, quantity, unit_price_twd) VALUES (1, 1, 1, '馬克杯', 2, 320)"),
  ]);
}

it("0014 讓既有商品沒有選項、既有變體販售中且不指定圖片、既有訂單明細沒有選項快照，資料原樣保留", async () => {
  await seedThrough0013();

  await applyD1Migrations(db, env.TEST_MIGRATIONS);

  expect(await db.prepare("SELECT option1_name, option2_name FROM products WHERE id = 1").first()).toEqual({ option1_name: "", option2_name: "" });
  // 0020 把舊已付款訂單（2 件）加回在庫數：4 → 6
  expect(await db.prepare("SELECT price_twd, on_hand, option1_value, option2_value, discontinued_at, image_id FROM product_variants WHERE id = 1").first())
    .toEqual({ price_twd: 320, on_hand: 6, option1_value: "", option2_value: "", discontinued_at: null, image_id: null });
  expect(await db.prepare("SELECT quantity, unit_price_twd, variant_label FROM order_lines WHERE order_id = 1").first()).toEqual({ quantity: 2, unit_price_twd: 320, variant_label: "" });
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
});

it("同商品的選項值組合由唯一索引擋下重複", async () => {
  await seedThrough0013();
  await applyD1Migrations(db, env.TEST_MIGRATIONS);

  await db.prepare("INSERT INTO product_variants (product_id, is_default, price_twd, option1_value) VALUES (1, 0, 100, '白')").run();
  await expect(db.prepare("INSERT INTO product_variants (product_id, is_default, price_twd, option1_value) VALUES (1, 0, 100, '白')").run()).rejects.toThrow();
});

it("沒有使用任何新功能時，回復程序移除新欄位並可重新套用 0014", async () => {
  await seedThrough0013();
  await applyD1Migrations(db, env.TEST_MIGRATIONS);

  // 回復順序由新到舊：0026 先移除不可售欄位與退貨資料表（流水與變體回到 0025 結構），0020 先把已付款訂單的數量扣回（回到付款扣庫語意），0019 的欄位在 product_variants 上，須先移除
  await db.batch([...rollback0026Sql.split("--> statement-breakpoint"), ...rollback0021Sql.split("--> statement-breakpoint"), ...rollback0020Sql.split("--> statement-breakpoint"), ...rollback0019Sql.split("--> statement-breakpoint"), ...rollbackSql.split("--> statement-breakpoint")].map((statement) => db.prepare(statement)));

  const columns = async (table: string) => (await db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all<{ name: string }>()).results.map(({ name }) => name);
  expect(await columns("product_variants")).toEqual(["id", "product_id", "is_default", "price_twd", "compare_at_price_twd", "on_hand"]);
  expect(await columns("products")).not.toContain("option1_name");
  expect(await columns("order_lines")).not.toContain("variant_label");
  expect(await db.prepare("SELECT price_twd, on_hand FROM product_variants WHERE id = 1").first()).toEqual({ price_twd: 320, on_hand: 4 });

  await applyD1Migrations(db, env.TEST_MIGRATIONS);
  expect(await columns("product_variants")).toContain("discontinued_at");
});

it.each([
  ["商品設了選項", "UPDATE products SET option1_name = '顏色' WHERE id = 1"],
  ["變體有選項值", "UPDATE product_variants SET option1_value = '白' WHERE id = 1"],
  ["變體被停賣", "UPDATE product_variants SET discontinued_at = 5 WHERE id = 1"],
  ["變體指定了圖片", "UPDATE product_variants SET image_id = 'image-1' WHERE id = 1"],
  ["訂單明細有選項快照", "UPDATE order_lines SET variant_label = '白' WHERE order_id = 1"],
])("%s時回復程序拒絕執行，不破壞資料", async (_name, change) => {
  await seedThrough0013();
  await applyD1Migrations(db, env.TEST_MIGRATIONS);
  await db.prepare(change).run();

  const [dropGuard, createGuard, check] = rollbackSql.split("--> statement-breakpoint");
  await db.prepare(dropGuard!).run();
  await db.prepare(createGuard!).run();
  await expect(db.prepare(check!).run()).rejects.toThrow();

  expect(await db.prepare("SELECT count(*) AS n FROM pragma_table_info('product_variants') WHERE name = 'option1_value'").first()).toEqual({ n: 1 });
});
