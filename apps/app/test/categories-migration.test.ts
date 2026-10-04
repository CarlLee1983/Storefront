import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";

it("0009 把沒有分類的上架商品轉為下架，保留商品、庫存、圖片與訂單外鍵，並建立分類表", async () => {
  const db = env.MIGRATION_DB;
  await applyD1Migrations(db, env.TEST_MIGRATIONS.slice(0, 9));
  await db.batch([
    db.prepare(`INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES ('legacy', 'Legacy', 'legacy@example.test', 1, 0, 0)`),
    db.prepare(`INSERT INTO products (id, name, description, price_twd, on_hand, listed) VALUES (42, 'Listed product', 'Retain me', 320, 7, 1)`),
    db.prepare(`INSERT INTO products (id, name, description, price_twd, on_hand, listed) VALUES (43, 'Unlisted product', '', 100, 2, 0)`),
    db.prepare(`INSERT INTO product_images (id, product_id, upload_id, position, variants) VALUES ('image-42', 42, 'upload-42', 0, '[]')`),
    db.prepare(`INSERT INTO orders (id, customer_id, total_twd, shipping_name, shipping_phone, shipping_address, payment_deadline, created_at, idempotency_key, request_hash) VALUES (1, 'legacy', 320, 'Legacy', '0900000000', 'Address', 100, 0, 'legacy-key', 'hash')`),
    db.prepare(`INSERT INTO order_lines (order_id, product_id, product_name, quantity, unit_price_twd) VALUES (1, 42, 'Listed product', 1, 320)`),
  ]);

  // 只套到 0009 為止：此測試驗證 0009 本身，之後的遷移（例如 0013 把價格與庫存搬到變體）各有自己的測試
  await applyD1Migrations(db, env.TEST_MIGRATIONS.slice(0, 10));

  expect(await db.prepare("SELECT id, name, listed, on_hand, category_id, listed_at FROM products ORDER BY id").all()).toMatchObject({ results: [
    { id: 42, name: "Listed product", listed: 0, on_hand: 7, category_id: null, listed_at: null },
    { id: 43, name: "Unlisted product", listed: 0, on_hand: 2, category_id: null, listed_at: null },
  ] });
  expect(await db.prepare("SELECT product_id FROM product_images").first()).toEqual({ product_id: 42 });
  expect(await db.prepare("SELECT product_id, product_name FROM order_lines").first()).toEqual({ product_id: 42, product_name: "Listed product" });
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);

  // 新表可用：代稱唯一、商品可指向分類
  await db.prepare("INSERT INTO categories (slug, name, description) VALUES ('living', '客廳', '沙發')").run();
  await expect(db.prepare("INSERT INTO categories (slug, name, description) VALUES ('living', '另一個', 'x')").run()).rejects.toThrow();
  await db.prepare("UPDATE products SET category_id = 1 WHERE id = 42").run();
  await expect(db.prepare("UPDATE products SET category_id = 999 WHERE id = 42").run()).rejects.toThrow();
});
