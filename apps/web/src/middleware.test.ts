import { beforeEach, describe, expect, it, vi } from "vitest";

const app = vi.hoisted(() => ({
  fetch: vi.fn<(request: Request) => Promise<Response>>(),
  getCustomerSession: vi.fn<(cookie: string) => Promise<unknown>>(),
}));

vi.mock("cloudflare:workers", () => ({ env: { APP: app } }));
vi.mock("astro:middleware", () => ({ defineMiddleware: <T>(handler: T) => handler }));

const { onRequest } = await import("./middleware");

const SESSION_COOKIE = "better-auth.session_token=tok.sig";

async function run(url: string, init: RequestInit = {}, next = async () => new Response("page")) {
  const locals: Record<string, unknown> = {};
  const request = new Request(url, init);
  const context = { request, url: new URL(url), locals };
  const handler = onRequest as unknown as (
    context: unknown,
    next: () => Promise<Response>,
  ) => Promise<Response>;
  const response = await handler(context, next);
  return { response, locals };
}

beforeEach(() => {
  app.fetch.mockReset();
  app.getCustomerSession.mockReset();
  vi.restoreAllMocks();
});

describe("/api/auth/* 轉發", () => {
  it("302、Location 與多個 Set-Cookie 原樣回給瀏覽器", async () => {
    const forwarded = new Response(null, { status: 302, headers: { location: "/" } });
    forwarded.headers.append("set-cookie", "better-auth.session_token=a; Path=/; HttpOnly");
    forwarded.headers.append("set-cookie", "better-auth.session_data=b; Path=/; HttpOnly");
    app.fetch.mockResolvedValue(forwarded);

    const { response } = await run("https://storefront.example/api/auth/callback/line?code=1");

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/");
    expect(response.headers.getSetCookie()).toEqual([
      "better-auth.session_token=a; Path=/; HttpOnly",
      "better-auth.session_data=b; Path=/; HttpOnly",
    ]);
  });

  it("以 redirect: manual 轉發，method、body 與 Origin 不變，且不查 session", async () => {
    app.fetch.mockResolvedValue(new Response("{}"));

    await run("https://storefront.example/api/auth/sign-out", {
      method: "POST",
      headers: { origin: "https://storefront.example", cookie: SESSION_COOKIE },
      body: "{}",
    });

    const forwarded = app.fetch.mock.calls[0]![0];
    expect(forwarded.redirect).toBe("manual");
    expect(forwarded.method).toBe("POST");
    expect(forwarded.headers.get("origin")).toBe("https://storefront.example");
    expect(forwarded.headers.get("cookie")).toBe(SESSION_COOKIE);
    expect(app.getCustomerSession).not.toHaveBeenCalled();
  });
});

describe("/api/auth/* 轉發的來源 IP 標頭", () => {
  it("不轉送用戶端帶的 X-Forwarded-*，並帶上 Web 收到的 cf-connecting-ip", async () => {
    app.fetch.mockResolvedValue(new Response("{}"));

    await run("https://storefront.example/api/auth/sign-in/social", {
      method: "POST",
      headers: {
        "cf-connecting-ip": "203.0.113.7",
        "x-forwarded-for": "198.51.100.1, 10.0.0.1",
        "x-forwarded-host": "evil.example",
        "x-forwarded-proto": "http",
        origin: "https://storefront.example",
      },
      body: "{}",
    });

    const forwarded = app.fetch.mock.calls[0]![0];
    expect(forwarded.headers.get("cf-connecting-ip")).toBe("203.0.113.7");
    expect([...forwarded.headers.keys()].filter((name) => name.startsWith("x-forwarded-"))).toEqual([]);
    expect(forwarded.headers.get("origin")).toBe("https://storefront.example");
  });

  it("Web 沒收到 cf-connecting-ip 時，也不會有人為指定的來源 IP 標頭", async () => {
    app.fetch.mockResolvedValue(new Response("{}"));

    await run("https://storefront.example/api/auth/sign-out", {
      method: "POST",
      headers: { "x-forwarded-for": "198.51.100.1" },
      body: "{}",
    });

    const forwarded = app.fetch.mock.calls[0]![0];
    expect(forwarded.headers.has("cf-connecting-ip")).toBe(false);
    expect(forwarded.headers.has("x-forwarded-for")).toBe(false);
  });
});

describe("顧客 session 放進 locals", () => {
  it("沒有 Better Auth session cookie 時不呼叫 RPC（別的 cookie 也不算）", async () => {
    const { locals } = await run("https://storefront.example/", { headers: { cookie: "theme=dark" } });

    expect(app.getCustomerSession).not.toHaveBeenCalled();
    expect(locals["customer"]).toBeNull();
  });

  it("/admin 底下不查顧客 session（後台由 Access 保護，不顯示顧客狀態）", async () => {
    for (const path of ["/admin", "/admin/products/1"]) {
      const { locals } = await run(`https://storefront.example${path}`, { headers: { cookie: SESSION_COOKIE } });
      expect(locals["customer"]).toBeNull();
    }
    expect(app.getCustomerSession).not.toHaveBeenCalled();
  });

  it("有 session cookie 時把 RPC 的顧客放進 locals", async () => {
    const customer = { customerId: "c1", name: "Alice", expiresAt: 1 };
    app.getCustomerSession.mockResolvedValue({ customer, setCookies: [] });

    const { locals } = await run("https://storefront.example/", { headers: { cookie: SESSION_COOKIE } });

    expect(app.getCustomerSession).toHaveBeenCalledWith(SESSION_COOKIE);
    expect(locals["customer"]).toEqual(customer);
  });

  it("session 被延長時，RPC 回的 Set-Cookie 附加到頁面回應", async () => {
    app.getCustomerSession.mockResolvedValue({
      customer: { customerId: "c1", name: "Alice", expiresAt: 1 },
      setCookies: ["better-auth.session_token=new; Max-Age=604800; Path=/", "better-auth.session_data=x; Path=/"],
    });

    const { response } = await run(
      "https://storefront.example/",
      { headers: { cookie: SESSION_COOKIE } },
      async () => new Response("page", { headers: { "set-cookie": "other=1" } }),
    );

    expect(await response.text()).toBe("page");
    expect(response.headers.getSetCookie()).toEqual([
      "other=1",
      "better-auth.session_token=new; Max-Age=604800; Path=/",
      "better-auth.session_data=x; Path=/",
    ]);
  });

  it("頁面回應自己已經清掉 session cookie 時，不再附加 RPC 回的延長 cookie", async () => {
    app.getCustomerSession.mockResolvedValue({
      customer: { customerId: "c1", name: "Alice", expiresAt: 1 },
      setCookies: ["better-auth.session_token=new; Max-Age=604800; Path=/"],
    });
    const cleared = "better-auth.session_token=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax";

    const { response } = await run(
      "https://storefront.example/",
      { headers: { cookie: SESSION_COOKIE } },
      async () => new Response("page", { headers: { "set-cookie": cleared } }),
    );

    expect(response.headers.getSetCookie()).toEqual([cleared]);
  });

  it("RPC 丟例外時記一行結構化 log，當作未登入，公開頁面照常回應", async () => {
    app.getCustomerSession.mockRejectedValue(new Error("app down"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    const { response, locals } = await run("https://storefront.example/", {
      headers: { cookie: SESSION_COOKIE },
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("page");
    expect(locals["customer"]).toBeNull();
    const line = JSON.parse(log.mock.calls[0]![0] as string);
    expect(line).toMatchObject({ event: "customer_session_lookup_failed", error: "app down" });
  });
});

it("public images bypass session lookup and never set a session cookie", async () => {
  const { response } = await run("https://storefront.example/images/products/1/image.webp", { headers: { cookie: SESSION_COOKIE } });
  expect(app.getCustomerSession).not.toHaveBeenCalled();
  expect(response.headers.getSetCookie()).toEqual([]);
});
