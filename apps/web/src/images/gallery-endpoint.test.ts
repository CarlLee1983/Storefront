import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ getProductForAdmin: vi.fn(), reorderProductImages: vi.fn(), deleteProductImage: vi.fn() }));
vi.mock("cloudflare:workers", () => ({ env: { APP: mocks } }));
vi.mock("../admin/access-jwt", () => ({ readAccessJwt: () => "jwt" }));
const { ALL } = await import("../pages/admin/products/[id]/gallery");
async function run(method = "PUT", body: string | undefined = JSON.stringify({ imageIds: ["image"], imageId: "image", id: 999 }), origin = "https://example.com", id = "1") {
  const url = new URL("https://example.com/admin/products/1/gallery");
  return ALL({ url, params: { id }, request: new Request(url, { method, headers: { origin }, body: method === "GET" ? undefined : body }) } as unknown as Parameters<typeof ALL>[0]);
}
beforeEach(() => {
  vi.resetAllMocks(); mocks.getProductForAdmin.mockResolvedValue({ ok: true, data: { id: 1, images: [] } });
  mocks.reorderProductImages.mockResolvedValue({ ok: true, data: { id: 1 } });
  mocks.deleteProductImage.mockResolvedValue({ ok: true, data: { id: 1 } });
});
it("GET returns authenticated gallery with no-store", async () => {
  const response = await run("GET"); expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toMatchObject({ data: { images: [] } });
});
it("rejects unsupported methods, cross-origin writes and invalid product IDs", async () => {
  expect((await run("POST")).status).toBe(405);
  expect((await run("PUT", undefined, "https://evil.example")).status).toBe(403);
  expect((await run("DELETE", undefined, undefined, "bad")).status).toBe(404);
  expect(mocks.getProductForAdmin).not.toHaveBeenCalled();
});
it.each([["unauthorized",403],["product_not_found",404]])("preflight %s prevents mutation", async (reason, status) => {
  mocks.getProductForAdmin.mockResolvedValue({ ok: false, reason });
  expect((await run()).status).toBe(status); expect(mocks.reorderProductImages).not.toHaveBeenCalled();
});
it.each(["{", "null", "[]", "1", " ".repeat(4097)])("rejects malformed or oversized JSON", async body => {
  expect((await run("PUT", body)).status).toBe(400); expect(mocks.reorderProductImages).not.toHaveBeenCalled();
});
it("uses path product ID and forwards only the selected operation fields", async () => {
  expect((await run()).status).toBe(200); expect(mocks.reorderProductImages).toHaveBeenCalledWith("jwt", { id: 1, imageIds: ["image"] });
  expect((await run("DELETE")).status).toBe(200); expect(mocks.deleteProductImage).toHaveBeenCalledWith("jwt", { id: 1, imageId: "image" });
});
it.each([["unauthorized",403],["image_set_changed",400],["image_delete_failed",503]])("maps %s mutations", async (reason, status) => {
  mocks.deleteProductImage.mockResolvedValue({ ok: false, reason }); expect((await run("DELETE")).status).toBe(status);
});
it("normalizes failed RPCs", async () => {
  mocks.getProductForAdmin.mockRejectedValue(new Error("offline"));
  const response = await run(); expect(response.status).toBe(503); expect(await response.json()).toEqual({ ok: false, reason: "image_management_failed" });
});
