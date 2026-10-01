import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ getCategoryForAdmin: vi.fn(), setCategoryImage: vi.fn(), parse: vi.fn() }));
vi.mock("cloudflare:workers", () => ({ env: { APP: mocks } }));
vi.mock("../admin/access-jwt", () => ({ readAccessJwt: () => "jwt" }));
vi.mock("./upload", () => ({ imageUploadInput: mocks.parse }));
const { POST } = await import("../pages/admin/categories/[id]/image");
async function run(origin = "https://example.com", id = "1") {
  const url = new URL("https://example.com/admin/categories/1/image");
  return await POST({ url, params: { id }, request: new Request(url, { method: "POST", headers: { origin } }) } as unknown as Parameters<typeof POST>[0]);
}
beforeEach(() => { vi.resetAllMocks(); mocks.getCategoryForAdmin.mockResolvedValue({ ok: true, data: { id: 1 } }); mocks.parse.mockResolvedValue({ id: 1, variants: [] }); });
it("rejects cross-origin posts before RPC", async () => {
  expect((await run("https://evil.example")).status).toBe(403);
  expect(mocks.getCategoryForAdmin).not.toHaveBeenCalled();
});
it("rejects malformed category id", async () => expect((await run(undefined, "x")).status).toBe(404));
it.each([["unauthorized", 403], ["category_not_found", 404]])("rejects %s before reading upload", async (reason, status) => {
  mocks.getCategoryForAdmin.mockResolvedValue({ ok: false, reason });
  expect((await run()).status).toBe(status);
  expect(mocks.getCategoryForAdmin).toHaveBeenCalledWith("jwt", { id: 1 });
  expect(mocks.parse).not.toHaveBeenCalled(); expect(mocks.setCategoryImage).not.toHaveBeenCalled();
});
it("normalizes preflight outages to retryable JSON", async () => {
  mocks.getCategoryForAdmin.mockRejectedValue(new Error("D1 unavailable"));
  const response = await run();
  expect(response.status).toBe(503); expect(await response.json()).toEqual({ ok: false, reason: "image_upload_failed" });
});
it.each([[true, "", 201], [false, "unauthorized", 403], [false, "invalid_input", 400], [false, "image_upload_failed", 503]])("maps upload result %s %s", async (ok, reason, status) => {
  mocks.setCategoryImage.mockResolvedValue({ ok, reason });
  const response = await run(); expect(response.status).toBe(status);
  expect(mocks.setCategoryImage).toHaveBeenCalledWith("jwt", { id: 1, variants: [] });
});
