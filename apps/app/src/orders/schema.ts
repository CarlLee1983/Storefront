import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { user } from "../auth/schema";
import { productVariants, products } from "../catalog/schema";

/** 訂單狀態（CONTEXT.md 的五種）；存英文代碼，畫面顯示的中文名稱在 Web。 */
export const ORDER_STATUSES = ["pending_payment", "paid", "shipped", "expired", "cancelled"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** 待付款：訂單的訂單明細在此狀態時，其數量就是「保留」（見 `catalog/stock.ts`）。 */
export const PENDING_PAYMENT = "pending_payment" satisfies OrderStatus;

/** 已逾期：付款期限過了仍未付款，由 Cron 轉入；遲到的付款成功仍可轉為已付款（ADR 0001）。 */
export const EXPIRED = "expired" satisfies OrderStatus;

/** 已取消：顧客在付款前主動終止，是終點。 */
export const CANCELLED = "cancelled" satisfies OrderStatus;

/** 已出貨：管理員標記出貨，是終點，不能撤回。 */
export const SHIPPED = "shipped" satisfies OrderStatus;

export const orders = sqliteTable(
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
    /**
     * 讓訂單轉為已付款的那筆付款（`payments.id`）；還沒付款為 null。與轉已付款在同一句 UPDATE 寫入，
     * 「訂單是由哪一筆付款支付」以它為準：扣庫存與「需要處理」的判定都看它（沒有外鍵：orders 與 payments 互相參照）。
     */
    paidByPaymentId: integer("paid_by_payment_id"),
    /** 出貨時管理員填的物流單號；可空（出貨時可以不附）。 */
    trackingNumber: text("tracking_number"),
    /** 出貨時間，UTC epoch 毫秒；未出貨為 null。 */
    shippedAt: integer("shipped_at"),
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
    /** 必須等於 `variantId` 所屬變體的 `product_id`：結帳的 INSERT … SELECT 從變體取得，其他寫入路徑要自行維持。 */
    productId: integer("product_id")
      .notNull()
      .references(() => products.id),
    /** 販售單位：購物車、價格校驗與庫存保留都以變體為準；商品編號只用來取封面與連結。 */
    variantId: integer("variant_id")
      .notNull()
      .references(() => productVariants.id),
    /** 商品名稱快照；之後商品改名不影響已成立的訂單明細。 */
    productName: text("product_name").notNull(),
    quantity: integer("quantity").notNull(),
    /** 單價快照，新台幣整數元；之後商品改價不影響它。 */
    unitPriceTwd: integer("unit_price_twd").notNull(),
  },
  (table) => [
    uniqueIndex("order_lines_order_variant_uidx").on(table.orderId, table.variantId),
    // 保留總和依變體加總（見 `catalog/stock.ts`）
    index("order_lines_variant_idx").on(table.variantId),
    check("order_lines_quantity_check", sql`${table.quantity} > 0`),
  ],
);
