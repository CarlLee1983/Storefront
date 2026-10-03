import { describe, expect, it } from "vitest";
import { siteOrigin } from "./site-origin";

describe("siteOrigin", () => {
  const request = new URL("http://localhost:4321/sitemap.xml");
  it("有設定就用設定的 origin（去掉路徑與結尾斜線）", () => {
    expect(siteOrigin("https://shop.example/", request)).toBe("https://shop.example");
  });
  it("沒設定或空字串時用請求的 origin", () => {
    expect(siteOrigin(undefined, request)).toBe("http://localhost:4321");
    expect(siteOrigin("", request)).toBe("http://localhost:4321");
  });
});
