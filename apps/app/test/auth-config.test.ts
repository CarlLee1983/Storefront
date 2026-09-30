import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { parseAuthConfig } from "../src/auth/config";

const VALID = {
  BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-0000",
  BETTER_AUTH_URL: "http://localhost:4321",
  GOOGLE_CLIENT_ID: "google-id",
  GOOGLE_CLIENT_SECRET: "google-secret",
  LINE_CHANNEL_ID: "line-id",
  LINE_CHANNEL_SECRET: "line-secret",
};

describe("parseAuthConfig", () => {
  it("測試環境的 binding 是完整的設定", () => {
    expect(() => parseAuthConfig(env)).not.toThrow();
  });

  it("完整設定解析成 AuthConfig", () => {
    expect(parseAuthConfig(VALID)).toEqual({
      baseURL: "http://localhost:4321",
      secret: VALID.BETTER_AUTH_SECRET,
      google: { clientId: "google-id", clientSecret: "google-secret" },
      line: { clientId: "line-id", clientSecret: "line-secret" },
    });
  });

  it.each(Object.keys(VALID))("缺少 %s 時明確失敗並指出變數名稱", (name) => {
    const { [name]: _removed, ...rest } = VALID as Record<string, string>;
    expect(() => parseAuthConfig(rest)).toThrow(name);
  });

  it("空字串視同缺少", () => {
    expect(() => parseAuthConfig({ ...VALID, LINE_CHANNEL_SECRET: "" })).toThrow("LINE_CHANNEL_SECRET");
  });

  it("BETTER_AUTH_SECRET 短於 32 字元視為無效", () => {
    expect(() => parseAuthConfig({ ...VALID, BETTER_AUTH_SECRET: "short" })).toThrow("BETTER_AUTH_SECRET");
  });

  it("一次列出所有缺少的變數，且錯誤訊息不含設定值", () => {
    let message = "";
    try {
      parseAuthConfig({ BETTER_AUTH_URL: "http://localhost:4321", GOOGLE_CLIENT_ID: "secret-value" });
    } catch (error) {
      message = (error as Error).message;
    }
    for (const name of ["BETTER_AUTH_SECRET", "GOOGLE_CLIENT_SECRET", "LINE_CHANNEL_ID", "LINE_CHANNEL_SECRET"]) {
      expect(message).toContain(name);
    }
    expect(message).not.toContain("secret-value");
  });
});
