import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import rollbackSql from "../rollback/0033_low_stock_threshold.down.sql?raw";

const db = env.MIGRATION_DB;

/** 每個測試從空白資料庫開始（遷移會改結構，整個砍掉重來）。 */
beforeEach(async () => {
  const { results } = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'").all<{ name: string }>();
  await db.batch([
    db.prepare("PRAGMA defer_foreign_keys = ON"),
    ...results.map(({ name }) => db.prepare(`DROP TABLE IF EXISTS "${name}"`)),
  ]);
});

const variantColumns = async () => (await db.prepare("PRAGMA table_info(product_variants)").all<{ name: string }>()).results.map(({ name }) => name);

it("既有變體的門檻初始為 null（不提醒），回復程序移除欄位與索引並可重新套用 0033", async () => {
  await applyD1Migrations(db, env.TEST_MIGRATIONS);
  await db.batch([
    db.prepare("INSERT INTO products (id, name, description, listed) VALUES (1, 'p', '', 1)"),
    db.prepare("INSERT INTO product_variants (id, product_id, is_default, price_twd) VALUES (1, 1, 1, 100)"),
  ]);
  expect(await db.prepare("SELECT low_stock_threshold AS threshold FROM product_variants WHERE id = 1").first()).toEqual({ threshold: null });

  for (const statement of rollbackSql.split("--> statement-breakpoint")) await db.prepare(statement).run();
  expect(await variantColumns()).not.toContain("low_stock_threshold");
  const indexes = (await db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all<{ name: string }>()).results.map(({ name }) => name);
  expect(indexes).not.toContain("product_variants_low_stock_idx");

  await applyD1Migrations(db, env.TEST_MIGRATIONS);
  expect(await variantColumns()).toContain("low_stock_threshold");
});
