import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ getProductForAdmin: vi.fn(), addProductImage: vi.fn(), parse: vi.fn() }));
vi.mock("cloudflare:workers", () => ({ env: { APP: mocks } }));
vi.mock("../admin/access-jwt", () => ({ readAccessJwt: () => "jwt" }));
vi.mock("./upload", () => ({ imageUploadInput: mocks.parse }));
const { POST } = await import("../pages/admin/products/[id]/images");
async function run(origin = "https://example.com", id = "1") {
  const url = new URL("https://example.com/admin/products/1/images");
  return await POST({ url, params: { id }, request: new Request(url, { method: "POST", headers: { origin } }) } as unknown as Parameters<typeof POST>[0]);
}
beforeEach(() => { vi.resetAllMocks(); mocks.getProductForAdmin.mockResolvedValue({ ok: true, data: { id: 1 } }); mocks.parse.mockResolvedValue({ id: 1, variants: [] }); });
it("rejects cross-origin posts before RPC", async () => {
  expect((await run("https://evil.example")).status).toBe(403);
  expect(mocks.getProductForAdmin).not.toHaveBeenCalled();
});
it("rejects malformed product id", async () => expect((await run(undefined, "x")).status).toBe(404));
it.each([["unauthorized",403],["product_not_found",404]])("rejects %s before reading upload", async (reason, status) => {
  mocks.getProductForAdmin.mockResolvedValue({ ok: false, reason });
  expect((await run()).status).toBe(status);
  expect(mocks.parse).not.toHaveBeenCalled(); expect(mocks.addProductImage).not.toHaveBeenCalled();
});
it("normalizes preflight outages to retryable JSON", async () => {
  mocks.getProductForAdmin.mockRejectedValue(new Error("D1 unavailable"));
  const response = await run();
  expect(response.status).toBe(503); expect(await response.json()).toEqual({ ok: false, reason: "image_upload_failed" });
});
it("rejects malformed multipart without writes", async () => {
  mocks.parse.mockRejectedValue(new Error("invalid"));
  expect((await run()).status).toBe(400); expect(mocks.addProductImage).not.toHaveBeenCalled();
});
it.each([[true,"",201],[false,"unauthorized",403],[false,"image_limit",400],[false,"image_upload_failed",503]])("maps upload result %s %s", async (ok, reason, status) => {
  mocks.addProductImage.mockResolvedValue({ ok, reason });
  const response = await run(); expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(mocks.addProductImage).toHaveBeenCalledWith("jwt", { id: 1, variants: [] });
});
it("normalizes upload outages", async () => {
  mocks.addProductImage.mockRejectedValue(new Error("unavailable"));
  expect((await run()).status).toBe(503);
});
