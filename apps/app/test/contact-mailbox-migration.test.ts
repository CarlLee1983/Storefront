import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import rollbackSql from "../rollback/0016_contact_mailbox.down.sql?raw";

const db = env.MIGRATION_DB;
const THROUGH_0015 = 16;
const NEW_TABLES = ["contact_verifications", "mail_controls", "mail_deliveries", "mail_messages"];

/** 每個測試從空白資料庫開始（遷移會改結構，整個砍掉重來）。 */
beforeEach(async () => {
  const { results } = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'").all<{ name: string }>();
  await db.batch([
    db.prepare("PRAGMA defer_foreign_keys = ON"),
    ...results.map(({ name }) => db.prepare(`DROP TABLE IF EXISTS "${name}"`)),
  ]);
});

async function seedThrough0015() {
  await applyD1Migrations(db, env.TEST_MIGRATIONS.slice(0, THROUGH_0015));
  await db.prepare("INSERT INTO \"user\" (id, name, email, email_verified, created_at, updated_at) VALUES ('c1', '顧客', 'c1@example.com', 0, 0, 0)").run();
}

const tables = async () => (await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all<{ name: string }>()).results.map(({ name }) => name);

it("0016 只新增資料表，既有的登入資料原樣保留", async () => {
  await seedThrough0015();

  await applyD1Migrations(db, env.TEST_MIGRATIONS);

  expect(await tables()).toEqual(expect.arrayContaining(NEW_TABLES));
  expect(await db.prepare("SELECT email FROM \"user\" WHERE id = 'c1'").first()).toEqual({ email: "c1@example.com" });
});

it("沒有任何信箱資料時，回復程序移除新資料表並可重新套用 0016", async () => {
  await seedThrough0015();
  await applyD1Migrations(db, env.TEST_MIGRATIONS);

  for (const statement of rollbackSql.split("--> statement-breakpoint")) await db.prepare(statement).run();
  expect(await tables()).not.toContain("mail_messages");

  await applyD1Migrations(db, env.TEST_MIGRATIONS);
  expect(await tables()).toEqual(expect.arrayContaining(NEW_TABLES));
});

it("已有驗證請求時回復程序拒絕執行，不破壞資料", async () => {
  await seedThrough0015();
  await applyD1Migrations(db, env.TEST_MIGRATIONS);
  await db.prepare("INSERT INTO contact_verifications (customer_id, email, token, created_at, expires_at, verified_at) VALUES ('c1', 'a@example.com', 't', 0, 1, 0)").run();

  const [dropGuard, createGuard, check] = rollbackSql.split("--> statement-breakpoint");
  await db.prepare(dropGuard!).run();
  await db.prepare(createGuard!).run();
  await expect(db.prepare(check!).run()).rejects.toThrow();

  expect(await tables()).toContain("contact_verifications");
});
