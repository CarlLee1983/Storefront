import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { user } from "../auth/schema";
import { products } from "../catalog/schema";

/** 訂單狀態（CONTEXT.md 的五種）；存英文代碼，畫面顯示的中文名稱在 Web。 */
export const ORDER_STATUSES = ["pending_payment", "paid", "shipped", "expired", "cancelled"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** 待付款：訂單的訂單明細在此狀態時，其數量就是「保留」（見 `catalog/stock.ts`）。 */
export const PENDING_PAYMENT = "pending_payment" satisfies OrderStatus;

/** 已逾期：付款期限過了仍未付款，由 Cron 轉入；遲到的付款成功仍可轉為已付款（ADR 0001）。 */
export const EXPIRED = "expired" satisfies OrderStatus;

/** 已取消：顧客在付款前主動終止，是終點。 */
export const CANCELLED = "cancelled" satisfies OrderStatus;

export const orders =sqliteTable(
  "orders",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** 下單的顧客；顧客資料不隨訂單刪除，所以不設級聯。 */
    customerId: text("customer_id")
      .notNull()
      .references(() => user.id),
    status: text("status").$type<OrderStatus>().notNull().default(PENDING_PAYMENT),
    /** 總金額，新台幣整數元、含稅、免運；等於各訂單明細單價快照 × 數量的總和。 */
    totalTwd: integer("total_twd").notNull(),
    /** 收件資訊（Shipping Info）快照。 */
    shippingName: text("shipping_name").notNull(),
    shippingPhone: text("shipping_phone").notNull(),
    shippingAddress: text("shipping_address").notNull(),
    /** 付款期限（Payment Deadline），UTC epoch 毫秒。 */
    paymentDeadline: integer("payment_deadline").notNull(),
    /** 成立時間，UTC epoch 毫秒。 */
    createdAt: integer("created_at").notNull(),
    /** 結帳的冪等鍵；同一顧客同一個鍵只會成立一張訂單。 */
    idempotencyKey: text("idempotency_key").notNull(),
    /** 結帳內容（正規化後的明細與收件資訊）的 SHA-256 hex；同一個冪等鍵帶不同內容時靠它認出來。 */
    requestHash: text("request_hash").notNull(),
  },
  (table) => [
    uniqueIndex("orders_customer_idempotency_uidx").on(table.customerId, table.idempotencyKey),
    index("orders_customer_idx").on(table.customerId),
    check("orders_status_check", sql`${table.status} IN ('pending_payment', 'paid', 'shipped', 'expired', 'cancelled')`),
  ],
);

export const orderLines = sqliteTable(
  "order_lines",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    orderId: integer("order_id")
      .notNull()
      .references(() => orders.id),
    productId: integer("product_id")
      .notNull()
      .references(() => products.id),
    /** 商品名稱快照；之後商品改名不影響已成立的訂單明細。 */
    productName: text("product_name").notNull(),
    quantity: integer("quantity").notNull(),
    /** 單價快照，新台幣整數元；之後商品改價不影響它。 */
    unitPriceTwd: integer("unit_price_twd").notNull(),
  },
  (table) => [
    uniqueIndex("order_lines_order_product_uidx").on(table.orderId, table.productId),
    // 保留總和依商品加總（見 `catalog/stock.ts`）
    index("order_lines_product_idx").on(table.productId),
    check("order_lines_quantity_check", sql`${table.quantity} > 0`),
  ],
);
