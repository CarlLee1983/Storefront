import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";

it("0007 將舊商品下架、改預設值，保留商品 ID、庫存與既有訂單外鍵", async () => {
  const db = env.MIGRATION_DB;
  await applyD1Migrations(db, env.TEST_MIGRATIONS.slice(0, 7));
  await db.batch([
    db.prepare(`INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES ('legacy', 'Legacy', 'legacy@example.test', 1, 0, 0)`),
    db.prepare(`INSERT INTO products (id, name, description, price_twd, on_hand, listed) VALUES (42, 'Legacy product', 'Retain me', 320, 7, 1)`),
    db.prepare(`INSERT INTO products (id, name, description, price_twd, on_hand, listed) VALUES (43, 'Unlisted product', '', 100, 2, 0)`),
    db.prepare(`INSERT INTO orders (id, customer_id, total_twd, shipping_name, shipping_phone, shipping_address, payment_deadline, created_at, idempotency_key, request_hash) VALUES (1, 'legacy', 320, 'Legacy', '0900000000', 'Address', 100, 0, 'legacy-key', 'hash')`),
    db.prepare(`INSERT INTO order_lines (order_id, product_id, product_name, quantity, unit_price_twd) VALUES (1, 42, 'Legacy product', 1, 320)`),
  ]);
  // 只套到 0007 為止：此測試驗證 0007 本身，之後的遷移各有自己的測試
  await applyD1Migrations(db, env.TEST_MIGRATIONS.slice(0, 8));
  expect(await db.prepare("SELECT id, name, listed, on_hand FROM products ORDER BY id").all()).toMatchObject({ results: [
    { id: 42, name: "Legacy product", listed: 0, on_hand: 7 },
    { id: 43, name: "Unlisted product", listed: 0, on_hand: 2 },
  ] });
  expect(await db.prepare("SELECT product_id, product_name FROM order_lines").first()).toEqual({ product_id: 42, product_name: "Legacy product" });
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  const inserted = await db.prepare("INSERT INTO products (name, description, price_twd) VALUES ('New', '', 100) RETURNING id, listed").first<{ id: number; listed: number }>();
  expect(inserted).toEqual({ id: 44, listed: 0 });
  const columns = (await db.prepare("PRAGMA table_info(products)").all()).results;
  expect(columns).toContainEqual(expect.objectContaining({ name: "listed", dflt_value: "false", notnull: 1 }));
  expect((await db.prepare("SELECT * FROM product_images").all()).results).toEqual([]);
});
