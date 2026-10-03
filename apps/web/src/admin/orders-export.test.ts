import { describe, expect, it } from "vitest";
import type { ExportRow } from "./orders-csv";
import { exportOrdersResponse } from "./orders-export";

const row = (id: number): ExportRow => ({
  id, createdAt: 0, customerEmail: `c${id}@x.com`, status: "paid", totalTwd: 100, needsAttention: false, paidTwd: 100, refundedTwd: 0, orderedQuantity: 1, shippedQuantity: 0,
  cancelledQuantity: 0, returnedQuantity: 0, lostQuantity: 0, shipmentReturnedQuantity: 0, invoiceNumbers: "", pendingAllowances: 0,
});

/** `Response.text()` 會吃掉 BOM；要驗 BOM 必須自己解碼並保留。 */
const rawText = async (response: Response) => new TextDecoder("utf-8", { ignoreBOM: true }).decode(await response.arrayBuffer());

describe("exportOrdersResponse", () => {
  it("逐批串成一份 CSV：只有一個標題列，各批依序接上，游標傳給下一批", async () => {
    const cursors: (number | undefined)[] = [];
    const response = await exportOrdersResponse(async (beforeId) => {
      cursors.push(beforeId);
      return beforeId === undefined
        ? { ok: true, data: { rows: [row(9), row(8)], nextBeforeId: 8 } }
        : { ok: true, data: { rows: [row(7)], nextBeforeId: null } };
    }, "orders.csv");

    const text = await rawText(response);

    expect(cursors).toEqual([undefined, 8]);
    expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="orders.csv"');
    expect(text.startsWith("\uFEFF訂單編號")).toBe(true);
    expect(text.match(/訂單編號/g)).toHaveLength(1);
    expect(text.split("\r\n").filter(Boolean).map((line) => line.split(",")[0]).slice(1)).toEqual(["9", "8", "7"]);
  });

  it("沒有符合的訂單仍給標題列", async () => {
    const response = await exportOrdersResponse(async () => ({ ok: true, data: { rows: [], nextBeforeId: null } }), "orders.csv");

    expect(await rawText(response)).toMatch(/^\uFEFF訂單編號[^\r\n]*\r\n$/);
  });

  it("未授權回 403、條件無效回 400，都不給檔案", async () => {
    const forbidden = await exportOrdersResponse(async () => ({ ok: false, reason: "unauthorized" }), "o.csv");
    const invalid = await exportOrdersResponse(async () => ({ ok: false, reason: "invalid_input" }), "o.csv");

    expect(forbidden.status).toBe(403);
    expect(invalid.status).toBe(400);
    expect(forbidden.headers.get("content-disposition")).toBeNull();
  });

  it("中途某批失敗時串流出錯，不留下看似完整的檔案", async () => {
    const response = await exportOrdersResponse(async (beforeId) => beforeId === undefined
      ? { ok: true, data: { rows: [row(9)], nextBeforeId: 9 } }
      : { ok: false, reason: "boom" }, "o.csv");

    await expect(response.text()).rejects.toThrow("匯出中斷：boom");
  });
});
