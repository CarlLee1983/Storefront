import { describe, expect, it, vi } from "vitest";
import { categorySlugFromPath, loadStorefrontNav } from "./nav";

describe("categorySlugFromPath", () => {
  it.each([
    ["/categories/living", "living"],
    ["/categories/living/", "living"],
    ["/categories/living-room", "living-room"],
  ])("%s 是分類頁，代稱 %s", (path, slug) => {
    expect(categorySlugFromPath(path)).toBe(slug);
  });

  it.each(["/", "/categories", "/categories/", "/categories/a/b", "/products/1", "/admin/categories/x"])("%s 不是分類頁", (path) => {
    expect(categorySlugFromPath(path)).toBeNull();
  });
});

describe("loadStorefrontNav", () => {
  const living = { id: 1, slug: "living", name: "客廳", description: "沙發" };

  it("RPC 成功時回傳分類與特價入口", async () => {
    expect(await loadStorefrontNav({ getStorefrontNav: async () => ({ ok: true, data: { categories: [living], hasSale: true } }) }))
      .toEqual({ categories: [living], hasSale: true });
  });

  it("RPC 丟出例外時當作沒有分類、沒有特價，不讓頁面失敗", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await loadStorefrontNav({ getStorefrontNav: async () => { throw new Error("binding down"); } })).toEqual({ categories: [], hasSale: false });
    expect(error).toHaveBeenCalledOnce();
    error.mockRestore();
  });
});
