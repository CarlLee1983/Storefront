import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import rollbackSql from "../rollback/0018_transaction_notifications.down.sql?raw";

const db = env.MIGRATION_DB;
const THROUGH_0017 = 18;

/** 每個測試從空白資料庫開始（遷移會改結構，整個砍掉重來）。 */
beforeEach(async () => {
  const { results } = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'").all<{ name: string }>();
  await db.batch([
    db.prepare("PRAGMA defer_foreign_keys = ON"),
    ...results.map(({ name }) => db.prepare(`DROP TABLE IF EXISTS "${name}"`)),
  ]);
});

async function seedThrough0017() {
  await applyD1Migrations(db, env.TEST_MIGRATIONS.slice(0, THROUGH_0017));
  await db.prepare("INSERT INTO \"user\" (id, name, email, email_verified, created_at, updated_at) VALUES ('c1', '顧客', 'c1@example.com', 0, 0, 0)").run();
  // 0016 時代的驗證信：沒有事件鍵，遷移後原樣保留
  await db.prepare("INSERT INTO mail_messages (customer_id, kind, subject, body, created_at) VALUES ('c1', 'contact_verification', 's', 'b', 0)").run();
}

const columnsOf = async (table: string) =>
  (await db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all<{ name: string }>()).results.map(({ name }) => name);

async function runRollback() {
  for (const statement of rollbackSql.split("--> statement-breakpoint")) await db.prepare(statement).run();
}

it("0018 只新增欄位，既有信件原樣保留且事件鍵為空", async () => {
  await seedThrough0017();

  await applyD1Migrations(db, env.TEST_MIGRATIONS);

  expect(await columnsOf("mail_messages")).toContain("event_key");
  expect(await columnsOf("mail_deliveries")).toContain("handled_by");
  expect(await db.prepare("SELECT kind, event_key FROM mail_messages").first()).toEqual({ kind: "contact_verification", event_key: null });
});

it("同一個事件鍵只能有一封信，驗證信（空事件鍵）不受限", async () => {
  await seedThrough0017();
  await applyD1Migrations(db, env.TEST_MIGRATIONS);
  const insert = "INSERT INTO mail_messages (customer_id, kind, subject, body, event_key, created_at) VALUES ('c1', 'order_placed', 's', 'b', ?, 0)";

  await db.prepare(insert).bind("order_placed:1").run();
  await expect(db.prepare(insert).bind("order_placed:1").run()).rejects.toThrow();
  await db.prepare(insert).bind(null).run();
  await db.prepare(insert).bind(null).run();
});

it("沒有事件鍵與處理紀錄時，回復程序移除欄位並可重新套用 0018", async () => {
  await seedThrough0017();
  await applyD1Migrations(db, env.TEST_MIGRATIONS);

  await runRollback();
  expect(await columnsOf("mail_messages")).not.toContain("event_key");
  expect(await columnsOf("mail_deliveries")).not.toContain("handled_by");

  await applyD1Migrations(db, env.TEST_MIGRATIONS);
  expect(await columnsOf("mail_messages")).toContain("event_key");
});

it("已有交易通知時回復程序拒絕執行，不破壞資料", async () => {
  await seedThrough0017();
  await applyD1Migrations(db, env.TEST_MIGRATIONS);
  await db.prepare("INSERT INTO mail_messages (customer_id, kind, subject, body, event_key, created_at) VALUES ('c1', 'order_placed', 's', 'b', 'order_placed:1', 0)").run();

  const [dropGuard, createGuard, check] = rollbackSql.split("--> statement-breakpoint");
  await db.prepare(dropGuard!).run();
  await db.prepare(createGuard!).run();
  await expect(db.prepare(check!).run()).rejects.toThrow();

  expect(await columnsOf("mail_messages")).toContain("event_key");
});
