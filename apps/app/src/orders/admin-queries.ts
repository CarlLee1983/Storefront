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

/** 所有顧客的訂單，新的在前；`status` 給了就只列該狀態。 */
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
    .innerJoin(user, eq(user.id, orders.customerId))
    .where(status === undefined ? undefined : eq(orders.status, status))
    .orderBy(desc(orders.id));
}

/** 訂單所屬顧客的 email；訂單不存在回 undefined。 */
export async function selectOrderCustomerEmail(db: DrizzleD1Database, orderId: number): Promise<string | undefined> {
  const [row] = await db
    .select({ email: user.email })
    .from(orders)
    .innerJoin(user, eq(user.id, orders.customerId))
    .where(eq(orders.id, orderId));
  return row?.email;
}
