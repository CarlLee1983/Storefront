import { and, asc, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { products } from "../catalog/schema";
import { availableExpr, availableQuantity, reservedQuantity } from "../catalog/stock";
import { batchAtEffectiveNow, effectiveNow } from "../shared/high-water-mark";
import type { ProductState } from "./diagnosis";
import type { CheckoutInput } from "./input";
import { PAYMENT_WINDOW_MS } from "./payment-deadline";
import { orderLines, orders, PENDING_PAYMENT, type OrderStatus } from "./schema";

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
      INSERT INTO order_lines (order_id, product_id, product_name, quantity, unit_price_twd)
      SELECT orders.id, products.id, products.name, json_extract(j.value, '$.quantity'), products.price_twd
      FROM orders
      JOIN json_each(${linesJson}) j
      JOIN products ON products.id = json_extract(j.value, '$.productId')
      WHERE ${ownOrder}
        AND NOT EXISTS (SELECT 1 FROM order_lines existing WHERE existing.order_id = orders.id)
        AND NOT EXISTS (
          SELECT 1 FROM json_each(${linesJson}) wanted
          LEFT JOIN products current ON current.id = json_extract(wanted.value, '$.productId')
          WHERE current.id IS NULL
            OR current.listed = 0
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

/** 結帳被拒之後的唯讀診斷：這些商品現在的價格、上架狀態與可售數量；不存在的商品不會出現在結果裡。 */
export async function selectProductStates(db: DrizzleD1Database, productIds: number[]): Promise<ProductState[]> {
  const rows = await db
    .select({
      id: products.id,
      priceTwd: products.priceTwd,
      listed: products.listed,
      onHand: products.onHand,
      reserved: reservedQuantity(sql`${products.id}`).as("reserved"),
    })
    .from(products)
    .where(inArray(products.id, productIds));
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
  lines: { productId: number; productName: string; quantity: number; unitPriceTwd: number }[];
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
  const rows = await db
    .select({
      order: orders,
      productId: orderLines.productId,
      productName: orderLines.productName,
      quantity: orderLines.quantity,
      unitPriceTwd: orderLines.unitPriceTwd,
    })
    .from(orders)
    // 用 left join：正常情況每張訂單都有明細，但若有殘留的空訂單，要讓它在讀取時看得見，而不是被 join 悄悄藏起來
    .leftJoin(orderLines, eq(orderLines.orderId, orders.id))
    .where(and(eq(orders.customerId, customerId), scopeFilter(scope)))
    .orderBy(desc(orders.id), asc(orderLines.id));

  const views = new Map<number, OrderView>();
  for (const { order, ...line } of rows) {
    let view = views.get(order.id);
    if (!view) {
      view = {
        id: order.id,
        status: order.status,
        totalTwd: order.totalTwd,
        shippingInfo: { name: order.shippingName, phone: order.shippingPhone, address: order.shippingAddress },
        paymentDeadline: order.paymentDeadline,
        createdAt: order.createdAt,
        lines: [],
      };
      views.set(order.id, view);
    }
    const { productId, productName, quantity, unitPriceTwd } = line;
    if (productId !== null && productName !== null && quantity !== null && unitPriceTwd !== null) {
      view.lines.push({ productId, productName, quantity, unitPriceTwd });
    }
  }
  return [...views.values()];
}
