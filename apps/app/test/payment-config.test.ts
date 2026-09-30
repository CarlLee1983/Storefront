import { describe, expect, it } from "vitest";
import { readPaymentConfig } from "../src/payments/config";

const VALID = { GATEWAY_BASE_URL: "https://gateway.example", GATEWAY_API_KEY: "key", BETTER_AUTH_URL: "https://shop.example/" };

describe("readPaymentConfig", () => {
  it("設定齊全：回傳閘道與去掉結尾斜線的 Web origin", () => {
    const result = readPaymentConfig(VALID);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.webOrigin).toBe("https://shop.example");
  });

  it.each([
    ["缺金鑰", { GATEWAY_API_KEY: undefined }, ["GATEWAY_API_KEY"]],
    ["金鑰是空字串", { GATEWAY_API_KEY: "" }, ["GATEWAY_API_KEY"]],
    ["缺閘道網址", { GATEWAY_BASE_URL: undefined }, ["GATEWAY_BASE_URL"]],
    ["閘道網址不是 http(s)", { GATEWAY_BASE_URL: "ftp://gateway.example" }, ["GATEWAY_BASE_URL"]],
    ["兩個都缺", { GATEWAY_API_KEY: undefined, GATEWAY_BASE_URL: "" }, ["GATEWAY_BASE_URL", "GATEWAY_API_KEY"]],
  ])("%s：回傳有問題的變數名稱（不含值）", (_label, override, invalid) => {
    const result = readPaymentConfig({ ...VALID, ...override });

    expect(result).toEqual({ ok: false, invalid: expect.arrayContaining(invalid) });
    expect(result.ok ? [] : result.invalid).toHaveLength(invalid.length);
  });
});
