import { desc, eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { user } from "../auth/schema";
import { orders, type OrderStatus } from "./schema";

export interface AdminOrderSummary {
  id: number;
  status: OrderStatus;
  totalTwd: number;
  /** 顧客識別：登入時取得的 email（姓名可能重複、也可由顧客自訂，email 才能認出是誰）。 */
  customerEmail: string;
  /** 成立時間，UTC epoch 毫秒。 */
  createdAt: number;
}

/**
 * 清單只取最新這麼多筆：不分頁的清單會隨訂單數無限長，超過這個量級（幾百張）就該做分頁或搜尋，
 * 那不在 #12 的範圍；門檻先擋住單次回應與頁面失控。
 */
export const ADMIN_ORDER_LIST_LIMIT = 200;

/** 所有顧客的訂單，新的在前，最多 `ADMIN_ORDER_LIST_LIMIT` 筆；`status` 給了就只列該狀態。 */
export async function selectOrdersForAdmin(db: DrizzleD1Database, status?: OrderStatus): Promise<AdminOrderSummary[]> {
  return db
    .select({
      id: orders.id,
      status: orders.status,
      totalTwd: orders.totalTwd,
      customerEmail: user.email,
      createdAt: orders.createdAt,
    })
    .from(orders)
    // 顧客不會被刪除（Better Auth 帳號不提供刪除），訂單一定對得到顧客，所以 innerJoin 不會漏掉訂單
    .innerJoin(user, eq(user.id, orders.customerId))
    .where(status === undefined ? undefined : eq(orders.status, status))
    .orderBy(desc(orders.id))
    .limit(ADMIN_ORDER_LIST_LIMIT);
}
