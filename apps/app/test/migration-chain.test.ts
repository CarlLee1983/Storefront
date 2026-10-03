import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { sql } from "drizzle-orm";
import { beforeEach, expect, it } from "vitest";
import { availableExpr } from "../src/catalog/stock";
import { productVariants } from "../src/catalog/schema";
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
 * main 時代（付款扣庫語意）的舊資料：燈具實體倉內 10 件，其中待付款保留 4、已付未出貨 2（已從在庫扣掉，所以在庫 8）、已出貨各 1（早已離倉）。
 * 訂單 1 待付款、2 已付未出貨、3 已出貨（舊紀錄沒有物流單號與出貨時間，未知）、4 已取消、5 已出貨（物流單號 TW1、有出貨時間，main 的出貨一律寫 shipped_at）、
 * 6 已逾期且遲到付款已退款（refunded，原因 late_success_unreclaimable、有退款時間）、7 已取消且遲到付款退款失敗（refund_failed，沒有原因）；總額含的運費在當時都是 0（免運）。
 */
async function seedLegacy() {
  await applyD1Migrations(db, env.TEST_MIGRATIONS.slice(0, THROUGH_0012));
  const order = (id: number, status: string, total: number, paidBy: number | null, tracking: string | null = null, shippedAt: number | null = null) =>
    db.prepare(`INSERT INTO orders (id, customer_id, status, total_twd, shipping_name, shipping_phone, shipping_address, payment_deadline, created_at, idempotency_key, request_hash, paid_by_payment_id, tracking_number, shipped_at) VALUES (${id}, 'legacy', '${status}', ${total}, 'L', '0900000000', 'A', 100, 0, 'key-${id}', 'hash', ${paidBy}, ?, ?)`).bind(tracking, shippedAt);
  const line = (orderId: number, quantity: number) =>
    db.prepare("INSERT INTO order_lines (order_id, product_id, product_name, quantity, unit_price_twd) VALUES (?, 1, '燈具', ?, 100)").bind(orderId, quantity);
  const payment = (id: number, orderId: number, amount: number, status = "succeeded", refundReason: string | null = null, refundAt: number | null = null) =>
    db.prepare("INSERT INTO payments (id, order_id, gateway_payment_id, amount_twd, status, created_at, expires_at, refund_reason, refund_at) VALUES (?, ?, ?, ?, ?, 0, 1, ?, ?)").bind(id, orderId, `gw_${id}`, amount, status, refundReason, refundAt);
  await db.batch([
    db.prepare(`INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES ('legacy', 'Legacy', 'legacy@example.test', 1, 0, 0)`),
    db.prepare("INSERT INTO products (id, name, description, price_twd, on_hand, listed) VALUES (1, '燈具', '', 100, 8, 1)"),
    order(1, "pending_payment", 400, null), order(2, "paid", 200, 1), order(3, "shipped", 100, 2), order(4, "cancelled", 900, null),
    order(5, "shipped", 100, 3, "TW1", 5000), order(6, "expired", 300, null), order(7, "cancelled", 200, null),
    line(1, 4), line(2, 2), line(3, 1), line(4, 9), line(5, 1), line(6, 3), line(7, 2),
    payment(1, 2, 200), payment(2, 3, 100), payment(3, 5, 100),
    payment(4, 6, 300, "refunded", "late_success_unreclaimable", 7000), payment(5, 7, 200, "refund_failed"),
  ]);
}

/** 遷移後的可售數量：直接用 App 的可售表達式（`availableExpr`，條件寫入與讀取共用）對遷移後的資料庫執行；實體在庫一併讀出。 */
const availableNow = async () =>
  (await drizzle(db)
    .select({ available: availableExpr(sql`${productVariants.onHand}`, sql`${productVariants.id}`), onHand: productVariants.onHand })
    .from(productVariants)
    .where(sql`${productVariants.isDefault} = 1`))[0]!;

const ordersAndLines = () => rows("SELECT o.id, o.status, o.total_twd AS total, l.quantity, l.unit_price_twd AS price FROM orders o JOIN order_lines l ON l.order_id = o.id ORDER BY o.id");

async function expectHeadState() {
  expect((await db.prepare("SELECT COUNT(*) AS n FROM d1_migrations").first<{ n: number }>())!.n).toBe(LATEST);
  expect(await ordersAndLines()).toEqual([
    { id: 1, status: "pending_payment", total: 400, quantity: 4, price: 100 },
    { id: 2, status: "paid", total: 200, quantity: 2, price: 100 },
    { id: 3, status: "shipped", total: 100, quantity: 1, price: 100 },
    { id: 4, status: "cancelled", total: 900, quantity: 9, price: 100 },
    { id: 5, status: "shipped", total: 100, quantity: 1, price: 100 },
    { id: 6, status: "expired", total: 300, quantity: 3, price: 100 },
    { id: 7, status: "cancelled", total: 200, quantity: 2, price: 100 },
  ]);
  // 每條舊明細都掛上商品的預設變體；原交易金額不變、運費拆分為 0（免運）
  expect(await rows("SELECT COUNT(*) AS n FROM order_lines WHERE variant_id IS NULL")).toEqual([{ n: 0 }]);
  expect(await rows("SELECT id, standard_shipping_fee_twd AS standard, large_shipping_fee_twd AS large FROM orders ORDER BY id")).toEqual([1, 2, 3, 4, 5, 6, 7].map((id) => ({ id, standard: 0, large: 0 })));
  // 付款金額不變；退款結果搬出付款（付款維持成功），進逐筆退款：refunded → succeeded、沒有原因的 refund_failed → unknown（舊版分不出明確失敗與逾時），金額全是商品款（免運）
  expect(await rows("SELECT order_id, amount_twd AS amount, status FROM payments ORDER BY order_id")).toEqual([
    { order_id: 2, amount: 200, status: "succeeded" }, { order_id: 3, amount: 100, status: "succeeded" }, { order_id: 5, amount: 100, status: "succeeded" },
    { order_id: 6, amount: 300, status: "succeeded" }, { order_id: 7, amount: 200, status: "succeeded" },
  ]);
  expect(await rows("SELECT order_id, reason, gateway_refund_id, amount_twd AS amount, goods_twd AS goods, shipping_twd AS shipping, status, settled_at FROM refunds ORDER BY order_id")).toEqual([
    { order_id: 6, reason: "late_success_unreclaimable", gateway_refund_id: "legacy_gw_4", amount: 300, goods: 300, shipping: 0, status: "succeeded", settled_at: 7000 },
    { order_id: 7, reason: "cancelled_order", gateway_refund_id: "legacy_gw_5", amount: 200, goods: 200, shipping: 0, status: "unknown", settled_at: null },
  ]);
  // 實體：8 + 已付未出貨 2 = 10；保留 4 + 2 = 6；可售 4，與遷移前（在庫 8 − 待付款 4）一致，沒有多出可售
  expect(await availableNow()).toEqual({ available: 4, onHand: 10 });
  // 已出貨的舊單各補一批整單批次：有的物流單號與出貨時間照搬，沒有的不編造；其他訂單沒有批次
  expect(await rows("SELECT order_id, tracking_number, shipped_at FROM shipments ORDER BY order_id")).toEqual([
    { order_id: 3, tracking_number: null, shipped_at: null }, { order_id: 5, tracking_number: "TW1", shipped_at: 5000 },
  ]);
}

it("A13 遷移鏈：main 時代舊資料套到 HEAD 不丟失，依序回復到 0012 後舊語意與資料還原，再重新套用結果相同", async () => {
  await seedLegacy();
  const legacyPayments = await rows("SELECT id, order_id, amount_twd, status, refund_reason, refund_at FROM payments ORDER BY id");

  await applyD1Migrations(db, env.TEST_MIGRATIONS);
  await expectHeadState();

  // 每支回復腳本一個 batch（單一交易，D1 的 defer_foreign_keys 才在整段內有效）
  for (const rollback of rollbacks) await db.batch(rollback.statements.map((statement) => db.prepare(statement)));
  expect(rollbacks.map(({ name }) => name).at(0)).toBe("0033_low_stock_threshold.down.sql");
  expect(rollbacks.map(({ name }) => name).at(-1)).toBe("0013_product_variants.down.sql");
  expect((await db.prepare("SELECT COUNT(*) AS n FROM d1_migrations").first<{ n: number }>())!.n).toBe(THROUGH_0012);
  expect(await rows("SELECT id, status, total_twd AS total, tracking_number, shipped_at FROM orders ORDER BY id")).toEqual([
    { id: 1, status: "pending_payment", total: 400, tracking_number: null, shipped_at: null }, { id: 2, status: "paid", total: 200, tracking_number: null, shipped_at: null },
    { id: 3, status: "shipped", total: 100, tracking_number: null, shipped_at: null }, { id: 4, status: "cancelled", total: 900, tracking_number: null, shipped_at: null },
    { id: 5, status: "shipped", total: 100, tracking_number: "TW1", shipped_at: 5000 }, { id: 6, status: "expired", total: 300, tracking_number: null, shipped_at: null },
    { id: 7, status: "cancelled", total: 200, tracking_number: null, shipped_at: null },
  ]);
  expect(await rows("SELECT order_id, quantity, unit_price_twd AS price FROM order_lines ORDER BY order_id")).toEqual([
    { order_id: 1, quantity: 4, price: 100 }, { order_id: 2, quantity: 2, price: 100 }, { order_id: 3, quantity: 1, price: 100 }, { order_id: 4, quantity: 9, price: 100 },
    { order_id: 5, quantity: 1, price: 100 }, { order_id: 6, quantity: 3, price: 100 }, { order_id: 7, quantity: 2, price: 100 },
  ]);
  // main 時代語意：已付款訂單在付款時就扣在庫，所以回到 8
  expect(await rows("SELECT on_hand FROM products WHERE id = 1")).toEqual([{ on_hand: 8 }]);
  // 付款的原欄位還原；沒有原因的 refund_failed 回復時由退款補上原因（cancelled_order）與時間（建立時間），其餘欄位與遷移前相同
  expect(await rows("SELECT id, order_id, amount_twd, status, refund_reason, refund_at FROM payments ORDER BY id")).toEqual(
    legacyPayments.map((payment) => payment.id === 5 ? { ...payment, refund_reason: "cancelled_order", refund_at: 0 } : payment),
  );

  await applyD1Migrations(db, env.TEST_MIGRATIONS);
  await expectHeadState();
});
