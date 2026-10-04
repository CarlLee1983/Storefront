import { describe, expect, it, vi } from "vitest";
import { withEdgeCache } from "./edge-cache";

const fakeCache = () => {
  const store = new Map<string, Response>();
  return {
    match: async (request: Request) => store.get(request.url)?.clone(),
    put: async (request: Request, response: Response) => void store.set(request.url, response),
  };
};
const context = () => ({ waitUntil: vi.fn((promise: Promise<unknown>) => void promise) });

describe("withEdgeCache", () => {
  const url = new URL("https://shop.example/sitemap.xml");

  it("第一次產生並寫入，第二次命中不再產生", async () => {
    const cache = fakeCache();
    const build = vi.fn(async () => new Response("<xml/>", { headers: { "cache-control": "public, max-age=300" } }));
    expect(await (await withEdgeCache(url, context(), build, cache)).text()).toBe("<xml/>");
    expect(await (await withEdgeCache(url, context(), build, cache)).text()).toBe("<xml/>");
    expect(build).toHaveBeenCalledTimes(1);
  });

  it("不同網址各自快取；非 200 不快取", async () => {
    const cache = fakeCache();
    const missing = vi.fn(async () => new Response("no", { status: 404 }));
    await withEdgeCache(new URL("https://shop.example/sitemap-9.xml"), context(), missing, cache);
    await withEdgeCache(new URL("https://shop.example/sitemap-9.xml"), context(), missing, cache);
    expect(missing).toHaveBeenCalledTimes(2);
  });
});
