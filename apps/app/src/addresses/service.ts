import { and, asc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { Clock } from "../shared/clock";
import { parseInput } from "../shared/input";
import { fail, ok, type Unauthorized } from "../shared/result";
import { addAddressInput, deleteAddressInput, MAX_ADDRESSES, updateAddressInput } from "./input";
import { customerAddresses } from "./schema";

/** 回傳顧客編號；沒有有效 session 回 null。 */
export type AuthenticateCustomer = (cookie: string) => Promise<string | null>;

const columns = {
  id: customerAddresses.id,
  name: customerAddresses.name,
  phone: customerAddresses.phone,
  address: customerAddresses.address,
};

/**
 * 顧客的地址簿。所有方法都先由 cookie 換顧客身分，查詢與寫入一律以該顧客為條件：
 * 別人的地址與不存在的編號得到同樣的 `address_not_found`，不洩漏存在與否。
 */
export function createAddressService(d1: D1Database, clock: Clock, authenticate: AuthenticateCustomer) {
  const db = drizzle(d1);
  const unauthorized: Unauthorized = { ok: false, reason: "unauthorized" };

  async function customerOf(cookie: unknown): Promise<string | null> {
    return typeof cookie === "string" ? authenticate(cookie) : null;
  }

  return {
    async listMyAddresses(cookie: unknown) {
      const customerId = await customerOf(cookie);
      if (!customerId) return unauthorized;
      return ok(await db.select(columns).from(customerAddresses).where(eq(customerAddresses.customerId, customerId)).orderBy(asc(customerAddresses.id)));
    },

    /** 新增一筆；筆數上限在同一個 INSERT 內判斷，並行新增也不會超過。 */
    async addAddress(cookie: unknown, input: unknown) {
      const customerId = await customerOf(cookie);
      if (!customerId) return unauthorized;
      const parsed = parseInput(addAddressInput, input);
      if (!parsed.ok) return parsed;

      const { name, phone, address } = parsed.data;
      const now = clock.now();
      const [created] = await db
        .insert(customerAddresses)
        .select(
          db.select({
            id: sql<number | null>`NULL`.as("id"),
            customerId: sql<string>`${customerId}`.as("customer_id"),
            name: sql<string>`${name}`.as("name"),
            phone: sql<string>`${phone}`.as("phone"),
            address: sql<string>`${address}`.as("address"),
            createdAt: sql<number>`${now}`.as("created_at"),
            updatedAt: sql<number>`${now}`.as("updated_at"),
          }).from(sql`(SELECT 1)`).where(sql`(SELECT count(*) FROM ${customerAddresses} WHERE ${customerAddresses.customerId} = ${customerId}) < ${MAX_ADDRESSES}`),
        )
        .returning(columns);
      return created ? ok(created) : fail("address_limit_reached");
    },

    async updateAddress(cookie: unknown, input: unknown) {
      const customerId = await customerOf(cookie);
      if (!customerId) return unauthorized;
      const parsed = parseInput(updateAddressInput, input);
      if (!parsed.ok) return parsed;

      const { addressId, name, phone, address } = parsed.data;
      const [updated] = await db
        .update(customerAddresses)
        .set({ name, phone, address, updatedAt: clock.now() })
        .where(and(eq(customerAddresses.id, addressId), eq(customerAddresses.customerId, customerId)))
        .returning(columns);
      return updated ? ok(updated) : fail("address_not_found");
    },

    async deleteAddress(cookie: unknown, input: unknown) {
      const customerId = await customerOf(cookie);
      if (!customerId) return unauthorized;
      const parsed = parseInput(deleteAddressInput, input);
      if (!parsed.ok) return parsed;

      const deleted = await db
        .delete(customerAddresses)
        .where(and(eq(customerAddresses.id, parsed.data.addressId), eq(customerAddresses.customerId, customerId)))
        .returning({ id: customerAddresses.id });
      return deleted.length === 1 ? ok({ addressId: parsed.data.addressId }) : fail("address_not_found");
    },
  };
}
