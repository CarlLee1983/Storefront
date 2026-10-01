import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppEntrypoint } from "../src/entrypoint";
import { mintAccessJwt } from "./access";
import { resetDb } from "./db";
import { ORIGIN } from "./oauth-stub";

/** 直接建構 entrypoint 並換掉 env：等同該環境的顧客登入設定缺漏，其他 binding（DB、Access）不變。 */
function appWith(overrides: Record<string, unknown>) {
  return new AppEntrypoint({} as ExecutionContext, { ...env, ...overrides } as Env);
}

const MISSING = { BETTER_AUTH_SECRET: undefined, LINE_CHANNEL_SECRET: "" };

describe("顧客登入設定缺漏時（Holdfast ADR 0008）", () => {
  beforeEach(async () => {
    await resetDb();
    await env.DB.prepare(
      "INSERT INTO products (name, description, price_twd, listed) VALUES ('馬克杯', '', 300, 1)",
    ).run();
  });
  afterEach(() => vi.restoreAllMocks());

  it("catalog RPC 照常運作", async () => {
    const result = await appWith(MISSING).listProducts();
    expect(result.ok && result.data.items.map((p) => p.name)).toEqual(["馬克杯"]);
  });

  it("管理 RPC 照常運作", async () => {
    const result = await appWith(MISSING).listProductsForAdmin(await mintAccessJwt());
    expect(result.ok).toBe(true);
  });

  it("auth 請求失敗：回 503、不含設定值，log 列出變數名稱", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = appWith({ ...MISSING, GOOGLE_CLIENT_SECRET: "super-secret-value" });

    const response = await app.fetch(new Request(`${ORIGIN}/api/auth/sign-in/social`, { method: "POST" }));

    expect(response.status).toBe(503);
    const line = JSON.parse(log.mock.calls[0]![0] as string);
    expect(line.event).toBe("auth_config_invalid");
    expect(line.error).toContain("BETTER_AUTH_SECRET");
    expect(line.error).toContain("LINE_CHANNEL_SECRET");
    expect(JSON.stringify(line)).not.toContain("super-secret-value");
  });

  it("getCustomerSession 丟出錯誤並記同一行 log（Web middleware 會當作未登入）", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(appWith(MISSING).getCustomerSession("better-auth.session_token=x")).rejects.toThrow(
      "BETTER_AUTH_SECRET",
    );
    expect(JSON.parse(log.mock.calls[0]![0] as string).event).toBe("auth_config_invalid");
  });
});
