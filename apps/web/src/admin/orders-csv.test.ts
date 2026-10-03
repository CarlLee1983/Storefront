import { describe, expect, it } from "vitest";
import { CSV_BOM, csvCell, csvHeader, csvRows, type ExportRow } from "./orders-csv";

describe("csvCell", () => {
  it.each(["=1+1", "+1", "-1", "@SUM(A1)", "\t=1", "\r=1"])("以公式字元開頭的文字 %j 前面補單引號", (value) => {
    expect(csvCell(value).replace(/^"|"$/g, "")).toMatch(/^'/);
  });

  it("含逗號、引號、換行的文字加引號並跳脫引號；一般文字與中文原樣", () => {
    expect(csvCell('小明, "大"')).toBe('"小明, ""大"""');
    expect(csvCell("a\nb")).toBe('"a\nb"');
    expect(csvCell("胡桃色 / 150 公分")).toBe("胡桃色 / 150 公分");
  });

  it("數字原樣輸出（負數不是公式）", () => {
    expect(csvCell(-5)).toBe("-5");
  });
});

const ROW: ExportRow = {
  id: 7, createdAt: Date.parse("2030-03-10T12:00:00+08:00"), customerEmail: "=cmd@x.com", status: "paid", totalTwd: 740, needsAttention: true,
  paidTwd: 740, refundedTwd: 100, orderedQuantity: 3, shippedQuantity: 1, cancelledQuantity: 1, returnedQuantity: 0, lostQuantity: 0, shipmentReturnedQuantity: 0,
  invoiceNumbers: "AB12345678 CD87654321", pendingAllowances: 1,
};

describe("csvHeader 與 csvRows", () => {
  it("標題列以 UTF-8 BOM 開頭、CRLF 結尾", () => {
    expect(csvHeader().startsWith(`${CSV_BOM}訂單編號,成立時間,`)).toBe(true);
    expect(csvHeader().endsWith("待折讓筆數\r\n")).toBe(true);
  });

  it("每張訂單一列，狀態用中文名稱，顧客 email 受公式跳脫保護", () => {
    const [line] = csvRows([ROW]).split("\r\n");

    expect(line).toContain("7,");
    expect(line).toContain(",'=cmd@x.com,已付款,740,是,740,100,3,1,1,0,0,0,AB12345678 CD87654321,1");
    expect(csvRows([])).toBe("");
  });
});
