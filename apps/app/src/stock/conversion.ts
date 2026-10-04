import { sql, type SQL } from "drizzle-orm";
import { effectiveNow } from "../shared/high-water-mark";
import type { StockMovementKind } from "./schema";

/**
 * 實物退回倉庫的庫存轉換所需的案件資訊（ADR 0006）：顧客退貨（`returns/`）與物流退回（`shipment-returns/`）共用同一套轉換，
 * 差別只在流水指向哪一種案件、案件的收回與檢查數量從哪裡讀。
 */
export interface StockReturnCase {
  /** 庫存流水上指向本案的欄位，也是「這案是否已轉換過」的冪等閘依據。 */
  movementColumn: "return_request_id" | "shipment_return_id";
  receivedKind: StockMovementKind;
  inspectedKind: StockMovementKind;
  caseId: number;
  /** 本案訂單編號的純量子查詢。 */
  orderId: SQL;
  /** 本案實際收到、依變體加總的子查詢（欄位 `variant_id`、`quantity`）。 */
  receivedByVariant: SQL;
  /** 本案檢查為良品、依變體加總的子查詢（欄位 `variant_id`、`quantity`）。 */
  sellableByVariant: SQL;
  /** 條件：本案此刻是「已收回」（且收到實物）。 */
  isReceived: SQL;
  /** 條件：本案此刻是「已完成」檢查。 */
  isCompleted: SQL;
}

/**
 * 收回入倉的兩句寫入（接在同一個 batch 裡）：實體在庫與不可售各加收到的數量、寫庫存流水（`receivedKind`）。
 * 只在這案還沒有收回流水時執行，所以同內容重送不會重複入庫；入庫在寫流水之前，流水的 `on_hand_after` 直接讀入庫後的數字。
 */
export function receiveIntoStock(c: StockReturnCase, actor: string, reason: string): SQL[] {
  const column = sql.raw(c.movementColumn);
  const notYetStocked = sql`NOT EXISTS (SELECT 1 FROM stock_movements WHERE ${column} = ${c.caseId} AND kind = ${c.receivedKind})`;
  return [
    sql`
      UPDATE product_variants
      SET on_hand = on_hand + (SELECT received.quantity FROM (${c.receivedByVariant}) received WHERE received.variant_id = product_variants.id),
        unavailable = unavailable + (SELECT received.quantity FROM (${c.receivedByVariant}) received WHERE received.variant_id = product_variants.id)
      WHERE id IN (SELECT variant_id FROM (${c.receivedByVariant})) AND ${c.isReceived} AND ${notYetStocked}
    `,
    sql`
      INSERT INTO stock_movements (variant_id, kind, delta, on_hand_after, unavailable_delta, unavailable_after, order_id, ${column}, actor, reason, created_at)
      SELECT variant.id, ${c.receivedKind}, received.quantity, variant.on_hand, received.quantity, variant.unavailable, ${c.orderId}, ${c.caseId}, ${actor}, ${reason}, ${effectiveNow}
      FROM (${c.receivedByVariant}) received JOIN product_variants variant ON variant.id = received.variant_id
      WHERE ${c.isReceived} AND ${notYetStocked}
    `,
  ];
}

/**
 * 檢查合格轉可售的兩句寫入（接在同一個 batch 裡）：不可售減去良品數量（在庫不變）、寫庫存流水（`inspectedKind`）。
 * 只在這案還沒有檢查流水時執行，重送不會重複轉換；損壞品留在不可售，直到管理員報廢（`stock/scrap.ts`）。
 */
export function convertInspectedToSellable(c: StockReturnCase, actor: string, reason: string): SQL[] {
  const column = sql.raw(c.movementColumn);
  const notYetConverted = sql`NOT EXISTS (SELECT 1 FROM stock_movements WHERE ${column} = ${c.caseId} AND kind = ${c.inspectedKind})`;
  return [
    sql`
      UPDATE product_variants
      SET unavailable = unavailable - (SELECT sellable.quantity FROM (${c.sellableByVariant}) sellable WHERE sellable.variant_id = product_variants.id)
      WHERE id IN (SELECT variant_id FROM (${c.sellableByVariant})) AND ${c.isCompleted} AND ${notYetConverted}
    `,
    sql`
      INSERT INTO stock_movements (variant_id, kind, delta, on_hand_after, unavailable_delta, unavailable_after, order_id, ${column}, actor, reason, created_at)
      SELECT variant.id, ${c.inspectedKind}, 0, variant.on_hand, -sellable.quantity, variant.unavailable, ${c.orderId}, ${c.caseId}, ${actor}, ${reason}, ${effectiveNow}
      FROM (${c.sellableByVariant}) sellable JOIN product_variants variant ON variant.id = sellable.variant_id
      WHERE ${c.isCompleted} AND ${notYetConverted}
    `,
  ];
}
