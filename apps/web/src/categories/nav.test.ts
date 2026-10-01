import { describe, expect, it, vi } from "vitest";
import { categorySlugFromPath, loadNavCategories } from "./nav";

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

describe("loadNavCategories", () => {
  const living = { id: 1, slug: "living", name: "客廳", description: "沙發" };

  it("RPC 成功時回傳分類", async () => {
    expect(await loadNavCategories({ listCategories: async () => ({ ok: true, data: [living] }) })).toEqual([living]);
  });

  it("RPC 丟出例外時當作沒有分類，不讓頁面失敗", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await loadNavCategories({ listCategories: async () => { throw new Error("binding down"); } })).toEqual([]);
    expect(error).toHaveBeenCalledOnce();
    error.mockRestore();
  });
});
