import { and, asc, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { currentCover } from "../images/cover-query";
import type { ProductImage } from "../product-images";
import { user } from "../auth/schema";
import { productVariants, products } from "../catalog/schema";
import { availableExpr, availableQuantity, reservedQuantity } from "../catalog/stock";
import { batchAtEffectiveNow, effectiveNow } from "../shared/high-water-mark";
import type { VariantState } from "./diagnosis";
import type { CheckoutInput } from "./input";
import { PAYMENT_WINDOW_MS } from "./payment-deadline";
import { CANCELLED, EXPIRED, orderLines, orders, PENDING_PAYMENT, SHIPPED, type OrderStatus } from "./schema";
import { canTransitionTo } from "./transitions";

export interface CheckoutRequest extends CheckoutInput {
  customerId: string;
  /** `requestHash(...)` 的結果，隨訂單一起寫入。 */
  requestHash: string;
}

/**
 * 結帳的單一 batch：成立訂單、保留（= 訂單明細）與清理，全有或全無。
 * 三句放在同一個 D1 batch，依序執行：
 *
 * 1. 先寫訂單本體（冪等鍵重複時 `ON CONFLICT DO NOTHING`，不動既有的訂單）。
 * 2. 再以「一句」`INSERT … SELECT … FROM json_each(?)` 寫入所有訂單明細（Holdfast ADR 0015，
 *    https://github.com/CarlLee1983/Holdfast/blob/main/docs/adr/0015-slot-batch-in-one-statement.md）。
 *    條件寫在這一句的 WHERE：這張訂單還沒有任何訂單明細（重送同一個冪等鍵時不重複保留），
 *    而且輸入中的「每一筆」都滿足（沒有任何一筆違規）。任一筆不滿足，這句一列都不寫，不會有只寫進一部分的明細。
 *    檢查與寫入同一句，可售數量由語句本身在寫入的當下判定，不是先讀再寫（Holdfast ADR 0004，
 *    https://github.com/CarlLee1983/Holdfast/blob/main/docs/adr/0004-oversell-guard-in-single-statement.md）。
 * 3. 最後刪除「這個冪等鍵下沒有任何訂單明細的訂單」。D1 batch 遇到「影響 0 列」不會回滾（Holdfast research §1），
 *    所以第 2 句被條件擋下時，第 1 句寫的訂單本體仍留著；這句把它清掉，整批不留下任何訂單或明細。
 *    重送成功過的冪等鍵時該訂單有明細，不會被刪。
 *
 * 語句之間沒有別的請求能插隊：D1 逐句、單寫者執行，batch 是一個交易。就算能插隊，也不會超賣：
 * 保留只由第 2 句寫入，它的條件在寫入當下判定；沒有明細的訂單本體不占用任何庫存。
 *
 * 冪等鍵重送但內容不同：第 1 句 DO NOTHING、第 2 句因「已有明細」不寫，整批不動既有訂單；
 * 指紋 `request_hash` 在第 1 句隨訂單一起寫入、之後不變，呼叫端讀回訂單時比對，不是先查再寫。
 *
 * 成敗看第 2 句的 `meta.changes`（> 0 = 這次呼叫成立了訂單）；= 0 時可能是冪等重送，也可能是被拒，
 * 由呼叫端再讀一次區分。時間用高水位的有效時間（Holdfast ADR 0011，
 * https://github.com/CarlLee1983/Holdfast/blob/main/docs/adr/0011-expiry-clock-source.md），`now` 只用來推進高水位。
 */
export async function placeOrderIfAvailable(d1: D1Database, request: CheckoutRequest, now: number): Promise<{ created: boolean }> {
  const { customerId, lines, shippingInfo, idempotencyKey, requestHash } = request;
  const totalTwd = lines.reduce((sum, line) => sum + line.seenUnitPriceTwd * line.quantity, 0);
  const linesJson = JSON.stringify(lines);
  const ownOrder = sql`${orders.customerId} = ${customerId} AND ${orders.idempotencyKey} = ${idempotencyKey}`;

  const [, insertedLines] = await batchAtEffectiveNow(d1, now, [
    sql`
      INSERT INTO orders (customer_id, status, total_twd, shipping_name, shipping_phone, shipping_address, payment_deadline, created_at, idempotency_key, request_hash)
      VALUES (${customerId}, ${PENDING_PAYMENT}, ${totalTwd}, ${shippingInfo.name}, ${shippingInfo.phone}, ${shippingInfo.address},
        ${effectiveNow} + ${PAYMENT_WINDOW_MS}, ${effectiveNow}, ${idempotencyKey}, ${requestHash})
      ON CONFLICT (customer_id, idempotency_key) DO NOTHING
    `,
    sql`
      INSERT INTO order_lines (order_id, product_id, variant_id, product_name, variant_label, quantity, unit_price_twd)
      SELECT orders.id, products.id, variant.id, products.name,
        variant.option1_value || CASE WHEN variant.option2_value <> '' THEN ' / ' || variant.option2_value ELSE '' END,
        json_extract(j.value, '$.quantity'), variant.price_twd
      FROM orders
      JOIN json_each(${linesJson}) j
      JOIN product_variants variant ON variant.id = json_extract(j.value, '$.variantId')
      JOIN products ON products.id = variant.product_id
      WHERE ${ownOrder}
        AND NOT EXISTS (SELECT 1 FROM order_lines existing WHERE existing.order_id = orders.id)
        AND NOT EXISTS (
          SELECT 1 FROM json_each(${linesJson}) wanted
          LEFT JOIN product_variants current ON current.id = json_extract(wanted.value, '$.variantId')
          LEFT JOIN products current_product ON current_product.id = current.product_id
          WHERE current.id IS NULL
            OR current_product.listed = 0
            OR current.discontinued_at IS NOT NULL
            OR current.price_twd <> json_extract(wanted.value, '$.seenUnitPriceTwd')
            OR ${availableExpr(sql`current.on_hand`, sql`current.id`)} < json_extract(wanted.value, '$.quantity')
        )
    `,
    sql`
      DELETE FROM orders
      WHERE ${ownOrder}
        AND NOT EXISTS (SELECT 1 FROM order_lines existing WHERE existing.order_id = orders.id)
    `,
  ]);
  return { created: insertedLines!.meta.changes > 0 };
}

/** 結帳被拒之後的唯讀診斷：這些變體現在的價格、所屬商品的上架狀態與可售數量；不存在的變體不會出現在結果裡。 */
export async function selectVariantStates(db: DrizzleD1Database, variantIds: number[]): Promise<VariantState[]> {
  const rows = await db
    .select({
      id: productVariants.id,
      priceTwd: productVariants.priceTwd,
      listed: products.listed,
      discontinued: sql<boolean>`${productVariants.discontinuedAt} is not null`.mapWith(Boolean),
      onHand: productVariants.onHand,
      reserved: reservedQuantity(sql`${productVariants.id}`).as("reserved"),
    })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(inArray(productVariants.id, variantIds));
  return rows.map(({ onHand, reserved, ...row }) => ({ ...row, available: availableQuantity(onHand, reserved) }));
}

export interface OrderView {
  id: number;
  status: OrderStatus;
  totalTwd: number;
  shippingInfo: { name: string; phone: string; address: string };
  /** 付款期限，UTC epoch 毫秒。 */
  paymentDeadline: number;
  /** 成立時間，UTC epoch 毫秒。 */
  createdAt: number;
  lines: { productId: number; variantId: number; productName: string; variantLabel: string; quantity: number; unitPriceTwd: number; cover: ProductImage | null }[];
  /** 出貨時附的物流單號；未出貨或出貨時沒附為 null。 */
  trackingNumber: string | null;
  /** 出貨時間，UTC epoch 毫秒；未出貨為 null。 */
  shippedAt: number | null;
}

export type OrderScope = { orderId: number } | { idempotencyKey: string };

function scopeFilter(scope: OrderScope | undefined): SQL | undefined {
  if (!scope) return undefined;
  return "orderId" in scope ? eq(orders.id, scope.orderId) : eq(orders.idempotencyKey, scope.idempotencyKey);
}

/** 顧客結帳時存下的內容指紋（依冪等鍵）；沒有這張訂單回 undefined。 */
export async function selectRequestHash(db: DrizzleD1Database, customerId: string, idempotencyKey: string): Promise<string | undefined> {
  const [row] = await db
    .select({ requestHash: orders.requestHash })
    .from(orders)
    .where(and(eq(orders.customerId, customerId), eq(orders.idempotencyKey, idempotencyKey)));
  return row?.requestHash;
}

/** 顧客自己的訂單（含訂單明細，名稱與單價都是下單當時的快照），新的在前；`scope` 再收窄到某一張。永遠限定顧客，看不到別人的。 */
export async function selectOrders(db: DrizzleD1Database, customerId: string, scope?: OrderScope): Promise<OrderView[]> {
  const views = await selectOrderViews(db, and(eq(orders.customerId, customerId), scopeFilter(scope)));
  // 顧客不需要（也不回傳）自己的 email
  return views.map(({ customerEmail: _customerEmail, ...view }) => view);
}

/** 管理員讀單張訂單（不限顧客），連同顧客 email；不存在回 undefined。 */
export async function selectOrderForAdmin(db: DrizzleD1Database, orderId: number): Promise<(OrderView & { customerEmail: string }) | undefined> {
  const [view] = await selectOrderViews(db, eq(orders.id, orderId));
  return view;
}

/** 訂單視圖的共同查詢：範圍（誰的、哪一張）由呼叫端的 `where` 決定。 */
async function selectOrderViews(db: DrizzleD1Database, where: SQL | undefined): Promise<(OrderView & { customerEmail: string })[]> {
  const rows = await db
    .select({
      order: orders,
      customerEmail: user.email,
      productId: orderLines.productId,
      variantId: orderLines.variantId,
      productName: orderLines.productName,
      variantLabel: orderLines.variantLabel,
      quantity: orderLines.quantity,
      unitPriceTwd: orderLines.unitPriceTwd,
      cover: currentCover(sql`${orderLines.productId}`),
    })
    .from(orders)
    // 顧客不會被刪除（Better Auth 帳號不提供刪除），訂單一定對得到顧客，所以 innerJoin 不會漏掉訂單
    .innerJoin(user, eq(user.id, orders.customerId))
    // 用 left join：正常情況每張訂單都有明細，但若有殘留的空訂單，要讓它在讀取時看得見，而不是被 join 悄悄藏起來
    .leftJoin(orderLines, eq(orderLines.orderId, orders.id))
    .where(where)
    .orderBy(desc(orders.id), asc(orderLines.id));

  const views = new Map<number, OrderView & { customerEmail: string }>();
  for (const { order, customerEmail, ...line } of rows) {
    let view = views.get(order.id);
    if (!view) {
      view = {
        id: order.id,
        customerEmail,
        status: order.status,
        totalTwd: order.totalTwd,
        shippingInfo: { name: order.shippingName, phone: order.shippingPhone, address: order.shippingAddress },
        paymentDeadline: order.paymentDeadline,
        createdAt: order.createdAt,
        lines: [],
        trackingNumber: order.trackingNumber,
        shippedAt: order.shippedAt,
      };
      views.set(order.id, view);
    }
    const { productId, variantId, productName, variantLabel, quantity, unitPriceTwd, cover } = line;
    if (productId !== null && variantId !== null && productName !== null && variantLabel !== null && quantity !== null && unitPriceTwd !== null) {
      view.lines.push({ productId, variantId, productName, variantLabel, quantity, unitPriceTwd, cover });
    }
  }

  return [...views.values()];
}

/**
 * 顧客取消自己的待付款訂單：單一條件式 UPDATE，是否成功由受影響列數判斷（不先讀再寫）。
 * 條件含顧客編號與待付款狀態；與 Cron 逾期並行時，先落地的一方贏，另一方影響 0 列。
 * 回傳 false 時不知道原因（別人的、不存在、或已不是待付款），由呼叫端再讀一次區分。
 *
 * 注意：這裡不處理「進行中的付款要先失效」，那一步在呼叫端（`cancelOrder`）先完成，再呼叫這個條件式取消。
 */
export async function cancelPendingOrder(db: DrizzleD1Database, customerId: string, orderId: number): Promise<boolean> {
  const rows = await db
    .update(orders)
    .set({ status: CANCELLED })
    .where(and(eq(orders.id, orderId), eq(orders.customerId, customerId), canTransitionTo(CANCELLED)))
    .returning({ id: orders.id });
  return rows.length > 0;
}

/**
 * 管理員出貨：單一條件式 UPDATE，是否成功由受影響列數判斷（不先讀再寫）；來源狀態由轉換表決定（只有已付款）。
 * 並行的兩次出貨，先落地的一方贏，另一方影響 0 列，物流單號不會被蓋掉。出貨時間用高水位的有效時間
 * （Holdfast ADR 0011），`now` 只用來推進高水位。回傳 false 時不知道原因（不存在、或不是已付款），由呼叫端再讀一次區分。
 */
export async function markOrderShipped(d1: D1Database, orderId: number, trackingNumber: string | null, now: number): Promise<boolean> {
  const [result] = await batchAtEffectiveNow(d1, now, [
    sql`
      UPDATE orders SET status = ${SHIPPED}, tracking_number = ${trackingNumber}, shipped_at = ${effectiveNow}
      WHERE id = ${orderId} AND ${canTransitionTo(SHIPPED)}
    `,
  ]);
  return result!.meta.changes > 0;
}

/** 某張訂單的存在與否（不限顧客，管理員用）。 */
export async function orderExists(db: DrizzleD1Database, orderId: number): Promise<boolean> {
  const [row] = await db.select({ id: orders.id }).from(orders).where(eq(orders.id, orderId));
  return row !== undefined;
}

/** 顧客自己的某張訂單的 `{ id, status }`（不讀明細）；別人的或不存在回 undefined。 */
export async function selectOrderStatus(
  db: DrizzleD1Database,
  customerId: string,
  orderId: number,
): Promise<{ id: number; status: OrderStatus } | undefined> {
  const [row] = await db
    .select({ id: orders.id, status: orders.status })
    .from(orders)
    .where(and(eq(orders.id, orderId), eq(orders.customerId, customerId)));
  return row;
}

/**
 * 把「待付款且付款期限 ≤ 有效時間」的訂單轉為已逾期，回傳轉換筆數。
 * 條件與轉換在同一句 UPDATE：是否逾期由語句在寫入當下判定，不先 SELECT 逾期清單再逐筆寫，
 * 所以重跑、同時跑兩次、或與顧客取消並行，每張訂單都只會被一個動作轉換一次，保留也只釋放一次。
 * 保留隨狀態改變自然釋放（見 `catalog/stock.ts`），這裡不動訂單明細。
 * 時間用高水位的有效時間（Holdfast ADR 0011），`now` 只用來推進高水位。
 */
export async function markOverdueOrdersExpired(d1: D1Database, now: number): Promise<number> {
  const [result] = await batchAtEffectiveNow(d1, now, [
    sql`
      UPDATE orders SET status = ${EXPIRED}
      WHERE ${canTransitionTo(EXPIRED)} AND payment_deadline <= ${effectiveNow}
    `,
  ]);
  return result!.meta.changes;
}
