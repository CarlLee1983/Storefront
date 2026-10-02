import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import rollbackSql from "../rollback/0015_product_info.down.sql?raw";

const db = env.MIGRATION_DB;
const THROUGH_0014 = 15;

/** 每個測試從空白資料庫開始（遷移會改結構，整個砍掉重來）。 */
beforeEach(async () => {
  const { results } = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'").all<{ name: string }>();
  await db.batch([
    db.prepare("PRAGMA defer_foreign_keys = ON"),
    ...results.map(({ name }) => db.prepare(`DROP TABLE IF EXISTS "${name}"`)),
  ]);
});

async function seedThrough0014() {
  await applyD1Migrations(db, env.TEST_MIGRATIONS.slice(0, THROUGH_0014));
  await db.prepare("INSERT INTO products (id, name, description, listed) VALUES (1, '馬克杯', '陶瓷', 0)").run();
}

const columns = async () => (await db.prepare("SELECT name FROM pragma_table_info('products')").all<{ name: string }>()).results.map(({ name }) => name);

it("0015 讓既有商品的尺寸、材質、保養為空字串，其餘資料原樣保留", async () => {
  await seedThrough0014();

  await applyD1Migrations(db, env.TEST_MIGRATIONS);

  expect(await db.prepare("SELECT name, description, dimensions, material, care FROM products WHERE id = 1").first())
    .toEqual({ name: "馬克杯", description: "陶瓷", dimensions: "", material: "", care: "" });
});

it("沒有填寫資訊時，回復程序移除新欄位並可重新套用 0015", async () => {
  await seedThrough0014();
  await applyD1Migrations(db, env.TEST_MIGRATIONS);

  for (const statement of rollbackSql.split("--> statement-breakpoint")) await db.prepare(statement).run();
  expect(await columns()).not.toContain("dimensions");

  await applyD1Migrations(db, env.TEST_MIGRATIONS);
  expect(await columns()).toContain("care");
});

it.each(["dimensions", "material", "care"])("%s 有內容時回復程序拒絕執行，不破壞資料", async (column) => {
  await seedThrough0014();
  await applyD1Migrations(db, env.TEST_MIGRATIONS);
  await db.prepare(`UPDATE products SET ${column} = '內容' WHERE id = 1`).run();

  const [dropGuard, createGuard, check] = rollbackSql.split("--> statement-breakpoint");
  await db.prepare(dropGuard!).run();
  await db.prepare(createGuard!).run();
  await expect(db.prepare(check!).run()).rejects.toThrow();

  expect(await columns()).toContain(column);
});
