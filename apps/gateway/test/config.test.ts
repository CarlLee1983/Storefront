import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import gateway from "../src/index";
import { TEST_API_KEY } from "./constants";
import { ORIGIN } from "./helpers";

/** 換掉 env：等同該環境缺了某個秘密，其他 binding（DB）不變。 */
const gatewayWith = (overrides: Record<string, unknown>) => (path: string, init?: RequestInit) =>
  gateway.fetch(new Request(`${ORIGIN}${path}`, init), { ...env, ...overrides } as Env);

describe("秘密缺少時 fail closed", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ["GATEWAY_API_KEY 未設定", { GATEWAY_API_KEY: undefined }, "GATEWAY_API_KEY"],
    ["GATEWAY_WEBHOOK_SECRET 是空字串", { GATEWAY_WEBHOOK_SECRET: "" }, "GATEWAY_WEBHOOK_SECRET"],
  ])("%s：所有請求回 503，log 只記變數名稱", async (_name, overrides, missing) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const send = gatewayWith(overrides);

    const api = await send("/v1/payments/pay_x", { headers: { Authorization: `Bearer ${TEST_API_KEY}` } });
    const page = await send("/pay/pay_x");
    const console_ = await send("/console");

    for (const response of [api, page, console_]) {
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ ok: false, error: { code: "gateway_misconfigured" } });
    }
    const line = JSON.parse(log.mock.calls[0]![0] as string);
    expect(line).toEqual({ event: "gateway_config_invalid", missing: [missing] });
    expect(JSON.stringify(line)).not.toContain(TEST_API_KEY);
  });
});
