import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import rollbackSql from "../rollback/0013_product_variants.down.sql?raw";
import { createAdminService } from "../src/admin/service";
import { systemClock } from "../src/shared/clock";
import { mintAccessJwt, adminDeps } from "./access";

const db = env.MIGRATION_DB;
const BEFORE_0013 = 13;
const THROUGH_0013 = 14;

/** 每個測試從空白資料庫開始（這個檔案的測試共用同一個 MIGRATION_DB，且遷移會改結構，所以整個砍掉重來）。 */
beforeEach(async () => {
  const { results } = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'").all<{ name: string }>();
  await db.batch([
    db.prepare("PRAGMA defer_foreign_keys = ON"),
    ...results.map(({ name }) => db.prepare(`DROP TABLE IF EXISTS "${name}"`)),
  ]);
});

/** 0012 結構下的既有資料：每種訂單狀態各一張、有原價的特價商品、庫存被待付款保留佔住的商品。 */
async function seedLegacy() {
  await applyD1Migrations(db, env.TEST_MIGRATIONS.slice(0, BEFORE_0013));
  const order = (id: number, status: string, total: number) =>
    db.prepare(`INSERT INTO orders (id, customer_id, status, total_twd, shipping_name, shipping_phone, shipping_address, payment_deadline, created_at, idempotency_key, request_hash) VALUES (${id}, 'legacy', '${status}', ${total}, 'L', '0900000000', 'A', 100, 0, 'key-${id}', 'hash')`);
  const line = (orderId: number, productId: number, name: string, quantity: number, price: number) =>
    db.prepare("INSERT INTO order_lines (order_id, product_id, product_name, quantity, unit_price_twd) VALUES (?, ?, ?, ?, ?)").bind(orderId, productId, name, quantity, price);
  await db.batch([
    db.prepare(`INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES ('legacy', 'Legacy', 'legacy@example.test', 1, 0, 0)`),
    db.prepare("INSERT INTO categories (id, slug, name, description) VALUES (1, 'living', '客廳', '')"),
    db.prepare("INSERT INTO products (id, name, description, price_twd, compare_at_price_twd, on_hand, listed, category_id, listed_at) VALUES (1, '特價桌', '', 900, 1200, 10, 1, 1, 5)"),
    db.prepare("INSERT INTO products (id, name, description, price_twd, on_hand, listed) VALUES (2, '馬克杯', '', 320, 4, 0)"),
    order(1, "pending_payment", 640), order(2, "paid", 900), order(3, "shipped", 320), order(4, "expired", 320), order(5, "cancelled", 320),
    line(1, 2, "馬克杯", 2, 320), line(2, 1, "特價桌", 1, 900), line(3, 2, "馬克杯", 1, 300), line(4, 2, "馬克杯", 1, 320), line(5, 2, "馬克杯", 1, 320),
  ]);
}

const admin = () => createAdminService(db, systemClock, { teamDomain: env.ACCESS_TEAM_DOMAIN, audience: env.ACCESS_AUD, jwksJson: env.ACCESS_JWKS_JSON }, adminDeps(env.PRODUCT_IMAGES));

it("0013 把每個既有商品轉為預設變體，價格、原價、庫存、保留與歷史訂單金額都不變", async () => {
  await seedLegacy();

  await applyD1Migrations(db, env.TEST_MIGRATIONS);

  // 0020 把舊已付款訂單（特價桌 1 件）加回在庫數：10 → 11
  expect((await db.prepare("SELECT product_id, is_default, price_twd, compare_at_price_twd, on_hand FROM product_variants ORDER BY product_id").all()).results).toEqual([
    { product_id: 1, is_default: 1, price_twd: 900, compare_at_price_twd: 1200, on_hand: 11 },
    { product_id: 2, is_default: 1, price_twd: 320, compare_at_price_twd: null, on_hand: 4 },
  ]);
  // 舊的明細逐筆指向該商品的預設變體；數量、單價與名稱快照原樣保留（已出貨那張的 300 不被現價 320 改寫）
  expect((await db.prepare("SELECT l.order_id, l.product_id, l.product_name, l.quantity, l.unit_price_twd, v.product_id AS variant_product, v.is_default FROM order_lines l JOIN product_variants v ON v.id = l.variant_id ORDER BY l.id").all()).results).toEqual([
    { order_id: 1, product_id: 2, product_name: "馬克杯", quantity: 2, unit_price_twd: 320, variant_product: 2, is_default: 1 },
    { order_id: 2, product_id: 1, product_name: "特價桌", quantity: 1, unit_price_twd: 900, variant_product: 1, is_default: 1 },
    { order_id: 3, product_id: 2, product_name: "馬克杯", quantity: 1, unit_price_twd: 300, variant_product: 2, is_default: 1 },
    { order_id: 4, product_id: 2, product_name: "馬克杯", quantity: 1, unit_price_twd: 320, variant_product: 2, is_default: 1 },
    { order_id: 5, product_id: 2, product_name: "馬克杯", quantity: 1, unit_price_twd: 320, variant_product: 2, is_default: 1 },
  ]);
  expect((await db.prepare("SELECT id, status, total_twd FROM orders ORDER BY id").all()).results).toEqual([
    { id: 1, status: "pending_payment", total_twd: 640 }, { id: 2, status: "paid", total_twd: 900 }, { id: 3, status: "shipped", total_twd: 320 },
    { id: 4, status: "expired", total_twd: 320 }, { id: 5, status: "cancelled", total_twd: 320 },
  ]);
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);

  // 待付款訂單的保留仍然佔住可售數量：在庫 4、保留 2、可售 2，沒有因遷移多出可售量；特價桌的已付款訂單（1 件）由 0020 加回在庫並轉為已付款保留，可售量同樣不變
  const jwt = await mintAccessJwt();
  expect(await admin().getProductForAdmin(jwt, { id: 2 })).toMatchObject({ ok: true, data: { priceTwd: 320, onHand: 4, reserved: 2, available: 2 } });
  expect(await admin().getProductForAdmin(jwt, { id: 1 })).toMatchObject({ ok: true, data: { priceTwd: 900, compareAtPriceTwd: 1200, onHand: 11, reserved: 1, available: 10 } });
});

it("每個商品至多一個預設變體，同商品可有其他變體（由後續票使用）", async () => {
  await seedLegacy();
  await applyD1Migrations(db, env.TEST_MIGRATIONS);

  await expect(db.prepare("INSERT INTO product_variants (product_id, is_default, price_twd) VALUES (1, 1, 100)").run()).rejects.toThrow();
  await db.prepare("INSERT INTO product_variants (product_id, is_default, price_twd, option1_value) VALUES (1, 0, 100, '另一組')").run();
});

it("回復程序把預設變體寫回商品、明細改回只指向商品，之後可重新套用 0013", async () => {
  await seedLegacy();
  await applyD1Migrations(db, env.TEST_MIGRATIONS.slice(0, THROUGH_0013));
  await db.prepare("UPDATE product_variants SET on_hand = 7, price_twd = 950 WHERE product_id = 1").run();

  for (const statement of rollbackSql.split("--> statement-breakpoint")) await db.prepare(statement).run();

  expect((await db.prepare("SELECT id, price_twd, compare_at_price_twd, on_hand FROM products ORDER BY id").all()).results).toEqual([
    { id: 1, price_twd: 950, compare_at_price_twd: 1200, on_hand: 7 },
    { id: 2, price_twd: 320, compare_at_price_twd: null, on_hand: 4 },
  ]);
  expect((await db.prepare("SELECT order_id, product_id, quantity, unit_price_twd FROM order_lines ORDER BY id").all()).results).toHaveLength(5);
  expect((await db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name IN ('product_variants', 'order_lines_order_variant_uidx')").first<{ n: number }>())!.n).toBe(0);
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);

  await applyD1Migrations(db, env.TEST_MIGRATIONS.slice(0, THROUGH_0013));
  expect((await db.prepare("SELECT product_id, price_twd, on_hand FROM product_variants ORDER BY product_id").all()).results).toEqual([
    { product_id: 1, price_twd: 950, on_hand: 7 }, { product_id: 2, price_twd: 320, on_hand: 4 },
  ]);
});

it("已有非預設變體時回復程序拒絕執行，不破壞資料", async () => {
  await seedLegacy();
  await applyD1Migrations(db, env.TEST_MIGRATIONS.slice(0, THROUGH_0013));
  await db.prepare("INSERT INTO product_variants (product_id, is_default, price_twd) VALUES (1, 0, 100)").run();

  const [dropGuard, createGuard, check] = rollbackSql.split("--> statement-breakpoint");
  await db.prepare(dropGuard!).run();
  await db.prepare(createGuard!).run();
  await expect(db.prepare(check!).run()).rejects.toThrow();

  expect((await db.prepare("SELECT count(*) AS n FROM product_variants").first<{ n: number }>())!.n).toBe(3);
});

it("有商品沒有任何變體時回復程序同樣拒絕執行", async () => {
  await seedLegacy();
  await applyD1Migrations(db, env.TEST_MIGRATIONS.slice(0, THROUGH_0013));
  // 明細參照變體，先移除商品 2 的明細才能刪它的變體
  await db.batch([db.prepare("DELETE FROM order_lines WHERE product_id = 2"), db.prepare("DELETE FROM product_variants WHERE product_id = 2")]);

  const [dropGuard, createGuard, check] = rollbackSql.split("--> statement-breakpoint");
  await db.prepare(dropGuard!).run();
  await db.prepare(createGuard!).run();
  await expect(db.prepare(check!).run()).rejects.toThrow();
});
