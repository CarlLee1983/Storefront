import { describe, expect, it, vi } from "vitest";
import { serveImage } from "./serve";
const key = `products/1/00000000-0000-4000-8000-000000000000/${"a".repeat(64)}.webp`;
describe("public read-only image handler", () => {
  it("streams a hit with immutable cache headers, WebP MIME and ETag", async () => {
    const body = new Response("image").body!;
    const bucket = { get: vi.fn(async () => ({ body, httpEtag: '"hash"', size: 5 })) };
    const response = await serveImage(bucket, key);
    expect(await response.text()).toBe("image");
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(response.headers.get("content-type")).toBe("image/webp");
    expect(response.headers.get("content-length")).toBe("5");
    expect(response.headers.get("etag")).toBe('"hash"');
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(bucket.get).toHaveBeenCalledExactlyOnceWith(key);
  });
  it("serves category images from the same bucket", async () => {
    const categoryKey = `categories/12/00000000-0000-4000-8000-000000000000/${"b".repeat(64)}.webp`;
    const bucket = { get: vi.fn(async () => ({ body: new Response("image").body!, httpEtag: '"hash"', size: 5 })) };
    expect((await serveImage(bucket, categoryKey)).status).toBe(200);
    expect(bucket.get).toHaveBeenCalledExactlyOnceWith(categoryKey);
  });
  it("returns 404 for missing objects", async () => expect((await serveImage({ get: async () => null }, key)).status).toBe(404));
  it.each([undefined, "", "../secret", "products/0/a.webp", key.replace(".webp", ".html")])("rejects malformed key %s without touching bucket", async value => {
    const bucket = { get: vi.fn() };
    expect((await serveImage(bucket, value)).status).toBe(404);
    expect(bucket.get).not.toHaveBeenCalled();
  });
});
