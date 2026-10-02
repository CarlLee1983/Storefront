import { describe, expect, it } from "vitest";
import { cancelErrorMessage, cancelOrderLocation, parsePaymentReturn, paymentErrorMessage, paymentReturnLocation, startPaymentLocation } from "./redirects";

describe("parsePaymentReturn（閘道導回的網址）", () => {
  it("取出訂單編號與閘道付款 ID", () => {
    expect(parsePaymentReturn("12", new URLSearchParams("paymentId=pay_3"))).toEqual({ orderId: 12, gatewayPaymentId: "pay_3" });
  });

  it.each([
    ["訂單編號不是正整數", "abc", "paymentId=pay_3"],
    ["訂單編號有前導零", "012", "paymentId=pay_3"],
    ["缺 paymentId", "12", ""],
    ["paymentId 是空字串", "12", "paymentId="],
    ["paymentId 含奇怪字元", "12", "paymentId=../x"],
  ])("%s：null（頁面直接回訂單頁，不打 RPC）", (_label, id, search) => {
    expect(parsePaymentReturn(id, new URLSearchParams(search))).toBeNull();
  });
});

describe("paymentReturnLocation（確認完導向哪裡）", () => {
  it("確認成功：訂單頁", () => {
    expect(paymentReturnLocation(12, { ok: true })).toBe("/orders/12");
  });

  it.each(["payment_gateway_unavailable", "payment_unavailable"])("%s：訂單頁並標記結果暫時無法確認", (reason) => {
    expect(paymentReturnLocation(12, { ok: false, reason })).toBe("/orders/12?payment=unconfirmed");
  });

  it("其他拒絕（找不到訂單或付款等）：訂單頁，由訂單頁決定顯示什麼", () => {
    expect(paymentReturnLocation(12, { ok: false, reason: "payment_not_found" })).toBe("/orders/12");
  });
});

describe("startPaymentLocation（發起付款完導向哪裡）", () => {
  it("成功：閘道的付款頁", () => {
    expect(startPaymentLocation(12, { ok: true, data: { paymentUrl: "https://gateway.example/pay/pay_1" } })).toBe("https://gateway.example/pay/pay_1");
  });

  it("被拒：回訂單頁並帶上原因", () => {
    expect(startPaymentLocation(12, { ok: false, reason: "payment_deadline_passed" })).toBe("/orders/12?payment_error=payment_deadline_passed");
  });
});

describe("paymentErrorMessage", () => {
  it("已知的原因有專屬說明，未知的一律用通用說明（不回顯網址上的字串）", () => {
    expect(paymentErrorMessage("payment_deadline_passed")).toContain("付款期限");
    expect(paymentErrorMessage("payment_window_closed")).toContain("付款期限前");
    expect(paymentErrorMessage("payment_gateway_unavailable")).toContain("付款");
    expect(paymentErrorMessage("payment_in_progress")).toContain("正在進行");
    expect(paymentErrorMessage("<script>")).toBe(paymentErrorMessage("no_such_reason"));
    expect(paymentErrorMessage("constructor")).toBe(paymentErrorMessage("no_such_reason"));
    expect(paymentErrorMessage(null)).toBeNull();
  });
});

describe("cancelOrderLocation（取消訂單完導向哪裡）", () => {
  it.each<[string, { ok: true } | { ok: false; reason: string }]>([
    ["取消成功", { ok: true }],
    ["訂單已不是待付款（含付款其實已成功）", { ok: false, reason: "order_not_cancellable" }],
  ])("%s：回訂單頁，讓顧客看到最新狀態", (_label, result) => {
    expect(cancelOrderLocation(12, result)).toBe("/orders/12");
  });

  it("進行中的付款處理不了：回訂單頁並帶上原因", () => {
    expect(cancelOrderLocation(12, { ok: false, reason: "payment_gateway_unavailable" })).toBe("/orders/12?cancel_error=payment_gateway_unavailable");
  });
});

describe("cancelErrorMessage", () => {
  it("說明訂單沒有取消；不認得的原因用通用說明，不回顯網址上的字串", () => {
    expect(cancelErrorMessage("payment_gateway_unavailable")).toContain("訂單仍保留原狀態");
    expect(cancelErrorMessage("payment_in_progress")).toContain("正在進行");
    expect(cancelErrorMessage("<script>")).toBe(cancelErrorMessage("no_such_reason"));
    expect(cancelErrorMessage("__proto__")).toBe(cancelErrorMessage("no_such_reason"));
    expect(cancelErrorMessage(null)).toBeNull();
  });
});
