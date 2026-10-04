import { describe, expect, it } from "vitest";
import { loadSitemapChunks } from "./sitemap-source";

describe("loadSitemapChunks", () => {
  it("合併分類與商品路徑", async () => {
    const chunks = await loadSitemapChunks({
      listCategories: async () => ({ ok: true, data: [{ slug: "living" }] }),
      listSitemapProductIds: async () => ({ ok: true, data: [2] }),
    });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual(expect.arrayContaining(["/categories/living", "/products/2"]));
  });

  it("任一來源失敗就丟錯，不給殘缺的 sitemap", async () => {
    await expect(loadSitemapChunks({
      listCategories: async () => ({ ok: true, data: [] }),
      listSitemapProductIds: async () => ({ ok: false }),
    })).rejects.toThrow();
  });
});
