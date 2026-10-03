import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import rollbackSql from "../rollback/0032_order_search_notes.down.sql?raw";

const db = env.MIGRATION_DB;

/** 每個測試從空白資料庫開始（遷移會改結構，整個砍掉重來）。 */
beforeEach(async () => {
  const { results } = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'").all<{ name: string }>();
  await db.batch([
    db.prepare("PRAGMA defer_foreign_keys = ON"),
    ...results.map(({ name }) => db.prepare(`DROP TABLE IF EXISTS "${name}"`)),
  ]);
});

const tables = async () => (await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all<{ name: string }>()).results.map(({ name }) => name);

async function seedOrderWithNote() {
  await applyD1Migrations(db, env.TEST_MIGRATIONS);
  await db.prepare("INSERT INTO \"user\" (id, name, email, email_verified, created_at, updated_at) VALUES ('c1', '顧客', 'c1@example.com', 0, 0, 0)").run();
  await db.prepare("INSERT INTO orders (customer_id, total_twd, shipping_name, shipping_phone, shipping_address, payment_deadline, created_at, idempotency_key, request_hash) VALUES ('c1', 100, 'n', 'p', 'a', 1, 1, 'k', 'h')").run();
}

it("客服備註由 trigger 保證只增不改不刪", async () => {
  await seedOrderWithNote();
  await db.prepare("INSERT INTO order_notes (order_id, actor, note, created_at) VALUES (1, 'admin@example.com', '電話確認過', 1)").run();

  await expect(db.prepare("UPDATE order_notes SET note = '改過' WHERE id = 1").run()).rejects.toThrow("order_notes is append-only");
  await expect(db.prepare("DELETE FROM order_notes WHERE id = 1").run()).rejects.toThrow("order_notes is append-only");
});

it("沒有備註時回復程序移除新資料表與索引並可重新套用 0032", async () => {
  await seedOrderWithNote();

  for (const statement of rollbackSql.split("--> statement-breakpoint")) await db.prepare(statement).run();
  expect(await tables()).not.toContain("order_notes");

  await applyD1Migrations(db, env.TEST_MIGRATIONS);
  expect(await tables()).toContain("order_notes");
});

it("已有備註時回復程序拒絕執行，不破壞資料", async () => {
  await seedOrderWithNote();
  await db.prepare("INSERT INTO order_notes (order_id, actor, note, created_at) VALUES (1, 'admin@example.com', '電話確認過', 1)").run();

  const [dropGuard, createGuard, check] = rollbackSql.split("--> statement-breakpoint");
  await db.prepare(dropGuard!).run();
  await db.prepare(createGuard!).run();
  await expect(db.prepare(check!).run()).rejects.toThrow();

  expect(await tables()).toContain("order_notes");
});
