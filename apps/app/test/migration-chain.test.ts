import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import rollback0013 from "../rollback/0013_product_variants.down.sql?raw";
import rollback0014 from "../rollback/0014_variant_options.down.sql?raw";
import rollback0015 from "../rollback/0015_product_info.down.sql?raw";
import rollback0016 from "../rollback/0016_contact_mailbox.down.sql?raw";
import rollback0017 from "../rollback/0017_address_book.down.sql?raw";
import rollback0018 from "../rollback/0018_transaction_notifications.down.sql?raw";
import rollback0019 from "../rollback/0019_shipping_fees.down.sql?raw";
import rollback0020 from "../rollback/0020_stock_ledger.down.sql?raw";
import rollback0021 from "../rollback/0021_shipments.down.sql?raw";
import rollback0022 from "../rollback/0022_shipment_delivery.down.sql?raw";
import rollback0023 from "../rollback/0023_payment_reconcile.down.sql?raw";
import rollback0024 from "../rollback/0024_refunds.down.sql?raw";
import rollback0025 from "../rollback/0025_cancellations.down.sql?raw";
import rollback0026 from "../rollback/0026_returns.down.sql?raw";
import rollback0027 from "../rollback/0027_return_batches.down.sql?raw";
import rollback0028 from "../rollback/0028_shipment_losses.down.sql?raw";
import rollback0029 from "../rollback/0029_shipment_returns.down.sql?raw";
import rollback0030 from "../rollback/0030_invoices.down.sql?raw";
import rollback0031 from "../rollback/0031_allowances.down.sql?raw";
import rollback0032 from "../rollback/0032_order_search_notes.down.sql?raw";
import rollback0033 from "../rollback/0033_low_stock_threshold.down.sql?raw";

const db = env.MIGRATION_DB;
/** main 時代的最後一支遷移是 0012（共 13 支）；本演練從它開始，一路套到 HEAD、依序回復再重新套用。 */
const THROUGH_0012 = 13;
const LATEST = env.TEST_MIGRATIONS.length;

/** 回復腳本依編號由新到舊（0033 → 0013）；0000～0012 沒有回復腳本，是 main 時代的基底。 */
const rollbacks = ([
  ["0033_low_stock_threshold.down.sql", rollback0033],
  ["0032_order_search_notes.down.sql", rollback0032],
  ["0031_allowances.down.sql", rollback0031],
  ["0030_invoices.down.sql", rollback0030],
  ["0029_shipment_returns.down.sql", rollback0029],
  ["0028_shipment_losses.down.sql", rollback0028],
  ["0027_return_batches.down.sql", rollback0027],
  ["0026_returns.down.sql", rollback0026],
  ["0025_cancellations.down.sql", rollback0025],
  ["0024_refunds.down.sql", rollback0024],
  ["0023_payment_reconcile.down.sql", rollback0023],
  ["0022_shipment_delivery.down.sql", rollback0022],
  ["0021_shipments.down.sql", rollback0021],
  ["0020_stock_ledger.down.sql", rollback0020],
  ["0019_shipping_fees.down.sql", rollback0019],
  ["0018_transaction_notifications.down.sql", rollback0018],
  ["0017_address_book.down.sql", rollback0017],
  ["0016_contact_mailbox.down.sql", rollback0016],
  ["0015_product_info.down.sql", rollback0015],
  ["0014_variant_options.down.sql", rollback0014],
  ["0013_product_variants.down.sql", rollback0013],
] as const).map(([name, sql]) => ({ name, statements: sql.split("--> statement-breakpoint") }));

/** 每個測試從空白資料庫開始（遷移會改結構，整個砍掉重來）。 */
beforeEach(async () => {
  const { results } = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'").all<{ name: string }>();
  await db.batch([
    db.prepare("PRAGMA defer_foreign_keys = ON"),
    ...results.map(({ name }) => db.prepare(`DROP TABLE IF EXISTS "${name}"`)),
  ]);
});

const rows = async (query: string) => (await db.prepare(query).all()).results;

/**
 * main 時代（付款扣庫語意）的舊資料：燈具實體倉內 10 件，其中待付款保留 4、已付未出貨 2（已從在庫扣掉，所以在庫 8）、已出貨 1（早已離倉）。
 * 訂單 1 待付款、2 已付未出貨、3 已出貨（舊紀錄沒有物流單號與出貨時間）、4 已取消；總額含的運費在當時都是 0（免運）。
 */
async function seedLegacy() {
  await applyD1Migrations(db, env.TEST_MIGRATIONS.slice(0, THROUGH_0012));
  const order = (id: number, status: string, total: number, paidBy: number | null) =>
    db.prepare(`INSERT INTO orders (id, customer_id, status, total_twd, shipping_name, shipping_phone, shipping_address, payment_deadline, created_at, idempotency_key, request_hash, paid_by_payment_id) VALUES (${id}, 'legacy', '${status}', ${total}, 'L', '0900000000', 'A', 100, 0, 'key-${id}', 'hash', ${paidBy})`);
  const line = (orderId: number, quantity: number) =>
    db.prepare("INSERT INTO order_lines (order_id, product_id, product_name, quantity, unit_price_twd) VALUES (?, 1, '燈具', ?, 100)").bind(orderId, quantity);
  const payment = (id: number, orderId: number, amount: number) =>
    db.prepare("INSERT INTO payments (id, order_id, gateway_payment_id, amount_twd, status, created_at, expires_at) VALUES (?, ?, ?, ?, 'succeeded', 0, 1)").bind(id, orderId, `gw_${id}`, amount);
  await db.batch([
    db.prepare(`INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES ('legacy', 'Legacy', 'legacy@example.test', 1, 0, 0)`),
    db.prepare("INSERT INTO products (id, name, description, price_twd, on_hand, listed) VALUES (1, '燈具', '', 100, 8, 1)"),
    order(1, "pending_payment", 400, null), order(2, "paid", 200, 1), order(3, "shipped", 100, 2), order(4, "cancelled", 900, null),
    line(1, 4), line(2, 2), line(3, 1), line(4, 9),
    payment(1, 2, 200), payment(2, 3, 100),
  ]);
}

/** 遷移後（HEAD 語意）從資料庫直接算出的可售數量：在庫 − 待付款與已付款保留 − 不可售。 */
const availableNow = async () =>
  (await db.prepare(`
    SELECT variant.on_hand - variant.unavailable - COALESCE((
      SELECT SUM(l.quantity) FROM order_lines l JOIN orders o ON o.id = l.order_id
      WHERE l.variant_id = variant.id AND o.status IN ('pending_payment', 'paid')
    ), 0) AS available, variant.on_hand AS onHand FROM product_variants variant WHERE is_default = 1`).first<{ available: number; onHand: number }>())!;

const ordersAndLines = () => rows("SELECT o.id, o.status, o.total_twd AS total, l.quantity, l.unit_price_twd AS price FROM orders o JOIN order_lines l ON l.order_id = o.id ORDER BY o.id");

async function expectHeadState() {
  expect((await db.prepare("SELECT COUNT(*) AS n FROM d1_migrations").first<{ n: number }>())!.n).toBe(LATEST);
  expect(await ordersAndLines()).toEqual([
    { id: 1, status: "pending_payment", total: 400, quantity: 4, price: 100 },
    { id: 2, status: "paid", total: 200, quantity: 2, price: 100 },
    { id: 3, status: "shipped", total: 100, quantity: 1, price: 100 },
    { id: 4, status: "cancelled", total: 900, quantity: 9, price: 100 },
  ]);
  // 每條舊明細都掛上商品的預設變體；原交易金額不變、運費拆分為 0（免運）
  expect(await rows("SELECT COUNT(*) AS n FROM order_lines WHERE variant_id IS NULL")).toEqual([{ n: 0 }]);
  expect(await rows("SELECT id, standard_shipping_fee_twd AS standard, large_shipping_fee_twd AS large FROM orders ORDER BY id")).toEqual([1, 2, 3, 4].map((id) => ({ id, standard: 0, large: 0 })));
  expect(await rows("SELECT order_id, amount_twd AS amount FROM payments ORDER BY order_id")).toEqual([{ order_id: 2, amount: 200 }, { order_id: 3, amount: 100 }]);
  // 實體：8 + 已付未出貨 2 = 10；保留 4 + 2 = 6；可售 4，與遷移前（在庫 8 − 待付款 4）一致，沒有多出可售
  expect(await availableNow()).toEqual({ available: 4, onHand: 10 });
  // 已出貨的舊單補一批整單批次，沒有的物流單號與出貨時間不編造；其他訂單沒有批次
  expect(await rows("SELECT order_id, tracking_number, shipped_at FROM shipments")).toEqual([{ order_id: 3, tracking_number: null, shipped_at: null }]);
}

it("A13 遷移鏈：main 時代舊資料套到 HEAD 不丟失，依序回復到 0012 後舊語意與資料還原，再重新套用結果相同", async () => {
  await seedLegacy();

  await applyD1Migrations(db, env.TEST_MIGRATIONS);
  await expectHeadState();

  // 每支回復腳本一個 batch（單一交易，D1 的 defer_foreign_keys 才在整段內有效）
  for (const rollback of rollbacks) await db.batch(rollback.statements.map((statement) => db.prepare(statement)));
  expect(rollbacks.map(({ name }) => name).at(0)).toBe("0033_low_stock_threshold.down.sql");
  expect(rollbacks.map(({ name }) => name).at(-1)).toBe("0013_product_variants.down.sql");
  expect((await db.prepare("SELECT COUNT(*) AS n FROM d1_migrations").first<{ n: number }>())!.n).toBe(THROUGH_0012);
  expect(await rows("SELECT id, status, total_twd AS total FROM orders ORDER BY id")).toEqual([
    { id: 1, status: "pending_payment", total: 400 }, { id: 2, status: "paid", total: 200 }, { id: 3, status: "shipped", total: 100 }, { id: 4, status: "cancelled", total: 900 },
  ]);
  expect(await rows("SELECT order_id, quantity, unit_price_twd AS price FROM order_lines ORDER BY order_id")).toEqual([
    { order_id: 1, quantity: 4, price: 100 }, { order_id: 2, quantity: 2, price: 100 }, { order_id: 3, quantity: 1, price: 100 }, { order_id: 4, quantity: 9, price: 100 },
  ]);
  // main 時代語意：已付款訂單在付款時就扣在庫，所以回到 8
  expect(await rows("SELECT on_hand FROM products WHERE id = 1")).toEqual([{ on_hand: 8 }]);
  expect(await rows("SELECT tracking_number, shipped_at FROM orders WHERE id = 3")).toEqual([{ tracking_number: null, shipped_at: null }]);
  expect(await rows("SELECT order_id, amount_twd AS amount FROM payments ORDER BY order_id")).toEqual([{ order_id: 2, amount: 200 }, { order_id: 3, amount: 100 }]);

  await applyD1Migrations(db, env.TEST_MIGRATIONS);
  await expectHeadState();
});
