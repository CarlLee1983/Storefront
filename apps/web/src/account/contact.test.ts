import { describe, expect, it } from "vitest";
import { contactFormToInput, deliveryStatusLabel, describeContactFailure, describeMailAdminFailure, describeVerifyFailure, mailKindLabel, parseMessageId, verificationStatusNote } from "./contact";

describe("聯絡 email 文案與表單", () => {
  it("表單原樣轉交 email（正規化由 App 負責），非文字欄位視為空", () => {
    const form = new FormData();
    form.set("email", " A@Example.com ");
    expect(contactFormToInput(form)).toEqual({ email: " A@Example.com " });
    expect(contactFormToInput(new FormData())).toEqual({ email: "" });
  });

  it("已知失敗原因顯示固定文案，未知原因與 prototype 代碼顯示通用訊息", () => {
    expect(describeContactFailure({ reason: "invalid_input" })).toContain("有效的 email");
    expect(describeContactFailure({ reason: "already_verified" })).toContain("已經是你的聯絡 email");
    expect(describeContactFailure({ reason: "too_many_requests" })).toContain("10 分鐘");
    expect(describeVerifyFailure({ reason: "verification_closed" })).toContain("過期");
    for (const reason of ["future_reason", "__proto__", "constructor"]) {
      expect(describeContactFailure({ reason })).toBe("目前無法送出驗證信，請稍後再試。");
      expect(describeVerifyFailure({ reason })).toBe("目前無法完成驗證，請稍後再試。");
      expect(describeMailAdminFailure({ reason })).toBe("操作失敗，請稍後再試");
      expect(mailKindLabel(reason)).toBe("通知");
    }
  });

  it("信件種類、驗證狀態、投遞結果與編號解析", () => {
    expect(mailKindLabel("contact_verification")).toBe("聯絡 email 驗證");
    expect(mailKindLabel("order_placed")).toBe("下單通知");
    expect(mailKindLabel("payment_succeeded")).toBe("付款成功通知");
    expect(mailKindLabel("payment_failed")).toBe("付款失敗通知");
    expect(mailKindLabel("payment_unsettled")).toBe("付款未能生效通知");
    expect(verificationStatusNote("pending")).toBeNull();
    expect(verificationStatusNote("expired")).toContain("過期");
    expect(deliveryStatusLabel("delivered")).toBe("已送達");
    expect(deliveryStatusLabel("failed")).toBe("投遞失敗");
    expect(deliveryStatusLabel("other")).toBe("狀態待確認");
    expect(parseMessageId("12")).toBe(12);
    for (const bad of [undefined, "0", "-1", "1.5", "abc", "01"]) expect(parseMessageId(bad)).toBeNull();
  });
});
