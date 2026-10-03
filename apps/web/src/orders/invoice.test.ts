import { describe, expect, it } from "vitest";
import { allowanceStatusLabel, customerAllowanceNote, customerAllowanceSummary, customerInvoiceStatusLabel, customerInvoiceStatusNote, invoiceAttemptLabel, invoiceStatusLabel } from "./invoice";

const format = (amount: number) => new Intl.NumberFormat("zh-TW").format(amount);

describe("發票進度的說明", () => {
  it("管理員看到如實的各狀態，不認得的原樣顯示", () => {
    expect(["pending", "unknown", "failed", "issued"].map(invoiceStatusLabel)).toEqual(["待開立", "結果不明（須先查證）", "明確失敗（可補辦）", "已開立"]);
    expect(invoiceStatusLabel("mystery")).toBe("mystery");
  });

  it("顧客只分已開立與開立中，不揭露不明與失敗，不認得的代碼不顯示原始值", () => {
    expect(["pending", "unknown", "failed"].map(customerInvoiceStatusLabel)).toEqual(["開立中", "開立中", "開立中"]);
    expect(customerInvoiceStatusLabel("issued")).toBe("已開立");
    expect(customerInvoiceStatusLabel("mystery")).toBe("發票狀態待確認");
    expect(customerInvoiceStatusNote("failed")).toContain("不影響付款與出貨");
    expect(customerInvoiceStatusNote("mystery")).not.toContain("mystery");
  });

  it("嘗試紀錄一行說明，不認得的原樣顯示", () => {
    expect(invoiceAttemptLabel("verify", "not_found")).toBe("向發票服務查證：發票服務從未收過這張發票");
    expect(invoiceAttemptLabel("send", "unknown")).toBe("開立發票：結果不明");
    expect(invoiceAttemptLabel("x", "y")).toBe("x：y");
  });
});

describe("憑證待補的說明", () => {
  it("沒有待折讓不顯示；有就說明仍是原額、不代表退款後的實際金額，且不宣稱已結清或剩餘金額", () => {
    expect(customerAllowanceNote(0, 0, format)).toBeNull();
    const note = customerAllowanceNote(1_300, 2, format)!;
    expect(note).toContain("2 筆退款共 NT$ 1,300");
    expect(note).toContain("仍顯示開立時的原額");
    expect(note).not.toMatch(/已結清|剩餘/);
  });
});

describe("折讓進度與顧客的折讓摘要", () => {
  it("管理員看到如實的各狀態，不認得的原樣顯示", () => {
    expect(["unknown", "failed", "issued"].map(allowanceStatusLabel)).toEqual(["結果不明（須先查證）", "明確失敗（可補辦）", "已折讓"]);
    expect(allowanceStatusLabel("pending")).toContain("待折讓");
    expect(allowanceStatusLabel("mystery")).toBe("mystery");
  });

  it("沒有已折讓的不顯示；全部折讓完成才給餘額", () => {
    const base = { status: "issued", amountTwd: 1_000, allowedTwd: 300, allowedCount: 1, pendingAllowanceCount: 0 };
    expect(customerAllowanceSummary({ ...base, allowedTwd: 0, allowedCount: 0 }, format)).toEqual({ allowed: null, balance: null });
    expect(customerAllowanceSummary(base, format)).toEqual({ allowed: "已折讓 1 筆，累計 NT$ 300", balance: "折讓後餘額 NT$ 700" });
  });

  it("還有未折讓的退款時只顯示已折讓的累計，不給餘額（不把原額標成已結清）", () => {
    const summary = customerAllowanceSummary({ status: "issued", amountTwd: 1_000, allowedTwd: 300, allowedCount: 1, pendingAllowanceCount: 1 }, format);
    expect(summary.allowed).toContain("累計 NT$ 300");
    expect(summary.balance).toBeNull();
  });
});
