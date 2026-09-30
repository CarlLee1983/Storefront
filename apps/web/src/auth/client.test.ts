import { describe, expect, it, vi } from "vitest";
import { requestSignOut, requestSocialLogin } from "./client";

const respond = (body: BodyInit | null, init?: ResponseInit) => vi.fn(async () => new Response(body, init));

describe("requestSocialLogin", () => {
  it("成功時回傳 provider 的授權網址，並以 POST 帶 provider 與 callbackURL", async () => {
    const fetchFn = respond(JSON.stringify({ url: "https://accounts.example/auth" }), { status: 200 });

    expect(await requestSocialLogin(fetchFn, "line", "/checkout")).toBe("https://accounts.example/auth");

    const [path, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/api/auth/sign-in/social");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ provider: "line", callbackURL: "/checkout" });
  });

  it.each([
    ["500 且不是 JSON", () => respond("Internal Server Error", { status: 500 })],
    ["503 且是 JSON", () => respond('{"error":"x"}', { status: 503 })],
    ["429", () => respond("Too Many Requests", { status: 429 })],
    ["200 但不是 JSON", () => respond("<html>", { status: 200 })],
    ["200 但沒有 url", () => respond("{}", { status: 200 })],
    ["網路錯誤", () => vi.fn(async () => Promise.reject(new TypeError("network")))],
  ])("%s：回傳 null，不丟例外", async (_label, makeFetch) => {
    expect(await requestSocialLogin(makeFetch(), "google", "/")).toBeNull();
  });
});

describe("requestSignOut", () => {
  it("回應 ok 才算成功", async () => {
    const fetchFn = respond("{}", { status: 200 });
    expect(await requestSignOut(fetchFn)).toBe(true);
    const [path, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/api/auth/sign-out");
    expect(init.method).toBe("POST");
  });

  it.each([
    ["500", () => respond("boom", { status: 500 })],
    ["網路錯誤", () => vi.fn(async () => Promise.reject(new TypeError("network")))],
  ])("%s：回傳 false，不丟例外", async (_label, makeFetch) => {
    expect(await requestSignOut(makeFetch())).toBe(false);
  });
});
